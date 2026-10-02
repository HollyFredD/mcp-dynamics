import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EOL } from "node:os";
import type { LoadedConfig } from "./config.ts";
import type { SessionLogger } from "./logger.ts";
import {
  MCP_PROTOCOL_VERSION,
  type JsonRpcMessage,
  type McpTool,
  type ToolCallResult,
} from "./types.ts";

export class McpError extends Error {
  /** Code JSON-RPC si l'erreur vient du protocole, sinon undefined. */
  readonly code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

export interface ServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  instructions?: string;
}

export interface CallOutcome {
  ok: boolean;
  result?: ToolCallResult;
  error?: string;
  durationMs: number;
  resultBytes: number;
}

interface Pending {
  resolve: (v: JsonRpcMessage) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/**
 * Client MCP « minimal » sur stdio, écrit à la main (0 dépendance runtime).
 *
 * Points non-évidents du protocole :
 *  - Le framing n'est PAS LSP (`Content-Length:`) : `StdioServerTransport` du SDK
 *    utilise du JSON délimité par des lignes (`JSON.stringify(msg) + "\n"`).
 *    D'où le buffer + split("\n") ci-dessous.
 *  - `initialize` doit être le tout premier message ; le serveur refuse
 *    `tools/list` avant `notifications/initialized`.
 *  - Les notifications n'ont pas de `id` : pas de réponse à attendre.
 *  - stdout est réservé au protocole : tout log du serveur doit aller sur
 *    stderr (c'est ce que fait `src/index.ts`).
 */
export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private tools: McpTool[] = [];
  private stderrRing: string[] = [];
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private closed = false;

  onCrash?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  onStderr?: (line: string) => void;
  onNotification?: (method: string, params: unknown) => void;

  private readonly cfg: LoadedConfig;
  private readonly logger: SessionLogger;

  // Champs explicites plutôt que "parameter properties" (non supporté par le
  // mode strip-only de Node, cf. script npm « tui »).
  constructor(cfg: LoadedConfig, logger: SessionLogger) {
    this.cfg = cfg;
    this.logger = logger;
  }

  get toolList(): McpTool[] {
    return this.tools;
  }

  get stderrLines(): string[] {
    return this.stderrRing;
  }

  get crashed(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.exitInfo;
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  /** Lance le serveur. Résout dès que le process est vivant (pas encore prêt). */
  spawn(): void {
    if (this.child) throw new Error("serveur déjà lancé");
    const { serverPath, config } = this.cfg;
    const args = [...config.serverArgs, serverPath];
    this.logger.log({ type: "server_spawn", command: config.serverCommand, args });

    const child = spawn(config.serverCommand, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        this.stderrRing.push(line);
        if (this.stderrRing.length > 50) this.stderrRing.shift();
        this.logger.log({ type: "stderr", line });
        this.onStderr?.(line);
      }
    });

    child.on("error", (err) => {
      this.logger.error("spawn", err.message);
      this.exitInfo = { code: null, signal: null };
      this.onCrash?.({ code: null, signal: null });
    });

    child.on("exit", (code, signal) => {
      this.logger.log({ type: "server_exit", code, signal });
      this.exitInfo = { code, signal };
      // Toute requête en attente est désormais sans réponse possible.
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({
          error: { code: -32000, message: `serveur arrêté (code ${code}, signal ${signal}) pendant ${p.method}` },
        });
      }
      this.pending.clear();
      if (!this.closed) this.onCrash?.({ code, signal });
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let idx: number;
    // Le serveur peut écrire plusieurs messages JSON par write() : on vide le
    // buffer jusqu'au dernier "\n" complet et on garde le reste (message partiel).
    while ((idx = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        // Du bruit sur stdout casse le protocole : on le trace sans le suivre.
        this.logger.error("stdout", `ligne non-JSON ignorée: ${line.slice(0, 200)}`);
        continue;
      }
      this.dispatch(msg);
    }
    // Garde-fou : si le buffer explose, on le signale (bug de framing côté serveur).
    if (this.stdoutBuffer.length > 64 * 1024 * 1024) {
      this.logger.error("stdout", "buffer démesuré, reset");
      this.stdoutBuffer = "";
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (msg.method !== undefined && msg.id === undefined) {
      this.logger.log({ type: "rpc_notification", method: msg.method });
      this.onNotification?.(msg.method, msg.params);
      return;
    }
    if (msg.id === undefined) return; // message inconnu : ignoré
    const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
    const pending = this.pending.get(id);
    if (!pending) return; // réponse tardive (après timeout) : on l'abandonne
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(msg);
  }

  /** Envoie une requête JSON-RPC et attend la réponse (ou le timeout). */
  private request(method: string, params?: unknown, timeoutMs = this.cfg.config.timeoutMs): Promise<JsonRpcMessage> {
    if (!this.child || !this.running) {
      return Promise.resolve({ error: { code: -32000, message: "serveur non lancé" } });
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    this.logger.log({ type: "rpc_request", id, method, params, bytes: payload.length });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.logger.error("rpc", `timeout ${timeoutMs}ms sur ${method}`);
        resolve({
          error: {
            code: -32001,
            message: `timeout après ${timeoutMs}ms sur ${method} (le serveur ne répond pas)`,
          },
        });
      }, timeoutMs);
      // Pas de ref/unref : on veut que le timer vive jusqu'à la réponse.
      this.pending.set(id, { resolve, timer, method });
      this.child!.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve({ error: { code: -32000, message: `écriture stdin impossible: ${err.message}` } });
        }
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.child || !this.running) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.child.stdin.write(payload);
    this.logger.log({ type: "rpc_notification", method });
  }

  /** Handshake complet : initialize → notifications/initialized → tools/list. */
  async initialize(): Promise<{ server: ServerInfo; tools: McpTool[] }> {
    this.spawn();
    const res = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false }, sampling: {} },
      clientInfo: { name: "mcp-dynamics-tui", version: "1.0.0" },
    });
    if (res.error) {
      throw new McpError(`initialize a échoué: ${res.error.message}`, res.error.code);
    }
    const result = (res.result ?? {}) as ServerInfo;
    // Négociation de version : si le serveur ne parle pas la nôtre on continue
    // quand même, les outils exposés sont stables dans ce dépôt.
    if (result.protocolVersion && result.protocolVersion !== MCP_PROTOCOL_VERSION) {
      this.logger.info(
        `protocole serveur ${result.protocolVersion} (client ${MCP_PROTOCOL_VERSION})`
      );
    }
    this.notify("notifications/initialized");

    const toolsRes = await this.request("tools/list");
    if (toolsRes.error) {
      throw new McpError(`tools/list a échoué: ${toolsRes.error.message}`, toolsRes.error.code);
    }
    const tools = ((toolsRes.result as { tools?: McpTool[] })?.tools ?? []) as McpTool[];
    this.tools = tools;
    return { server: result, tools };
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<CallOutcome> {
    const started = Date.now();
    const res = await this.request(
      "tools/call",
      { name, arguments: args },
      timeoutMs
    );
    const durationMs = Date.now() - started;
    if (res.error) {
      return { ok: false, error: res.error.message, durationMs, resultBytes: 0 };
    }
    const result = (res.result ?? {}) as ToolCallResult;
    // Convention MCP : une erreur applicative peut arriver en `result` avec
    // isError=true plutôt qu'en erreur JSON-RPC (cf. records.ts).
    if (result.isError) {
      const text = (result.content ?? [])
        .map((c) => (typeof c.text === "string" ? c.text : ""))
        .join(" ")
        .trim();
      return {
        ok: false,
        result,
        error: text || "outil a renvoyé isError=true (message vide)",
        durationMs,
        resultBytes: JSON.stringify(result).length,
      };
    }
    return { ok: true, result, durationMs, resultBytes: JSON.stringify(result).length };
  }

  /**
   * Forwarde un message JSON-RPC *tel quel* en préservant son `id` d'origine.
   * Utilisé par le mode `--proxy` : le client externe (Claude…) parle à la TUI,
   * qui relaie vers le vrai serveur en mesurant chaque aller-retour.
   * Résout `undefined` pour les notifications (pas de réponse attendue).
   */
  async forward(msg: JsonRpcMessage): Promise<JsonRpcMessage | undefined> {
    if (msg.id === undefined) {
      if (msg.method) this.notify(msg.method, msg.params);
      return undefined;
    }
    // Les implémentations MCP du marché (SDK officiel inclus) utilisent des ids
    // numériques. Pour un id non numérique on en alloue un interne et on
    // restaure l'id d'origine dans la réponse : la table `pending` reste indexée
    // par des entiers, comme le reste du client.
    const originalId = msg.id;
    const internalId = this.nextId++;
    const outbound: JsonRpcMessage = { ...msg, id: internalId };
    const payload = JSON.stringify(outbound) + "\n";
    this.logger.log({
      type: "rpc_request",
      id: internalId,
      method: msg.method ?? "?",
      params: msg.params,
      bytes: payload.length,
    });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(internalId);
        resolve({
          jsonrpc: "2.0",
          id: originalId,
          error: { code: -32001, message: `timeout après ${this.cfg.config.timeoutMs}ms (proxy)` },
        });
      }, this.cfg.config.timeoutMs);
      this.pending.set(internalId, {
        resolve: (v) => resolve({ ...v, id: originalId }),
        timer,
        method: msg.method ?? "?",
      });
      if (!this.child || !this.running) {
        clearTimeout(timer);
        this.pending.delete(internalId);
        resolve({ jsonrpc: "2.0", id: originalId, error: { code: -32000, message: "serveur non lancé" } });
        return;
      }
      this.child.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(internalId);
          resolve({ jsonrpc: "2.0", id: originalId, error: { code: -32000, message: err.message } });
        }
      });
    });
  }

  /** Termine proprement le serveur (SIGTERM puis SIGKILL). */
  async stop(graceMs = 2000): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ error: { code: -32000, message: "arrêt demandé par l'utilisateur" } });
    }
    this.pending.clear();
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      const t = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, graceMs);
      t.unref();
    });
    try {
      child.stdin.end();
    } catch {
      /* déjà fermé */
    }
    this.child = null;
  }
}

/** Erreur "az login manquant" traduite en message actionnable. */
export function humanizeAuthError(message: string, instanceUrl: string): string {
  const m = message.toLowerCase();
  if (
    m.includes("azure cli") ||
    m.includes("az login") ||
    m.includes("unavailablecredential") ||
    m.includes("failed to refresh") ||
    m.includes("please run 'az login'") ||
    m.includes("credentialunavailable") ||
    // Le SDK shell-out vers `az` : si le binaire est absent on obtient une
    // erreur de shell ("az: command not found" / "commande introuvable").
    (m.includes("az:") && m.includes("not found")) ||
    (m.includes("commande introuvable") && m.includes("az")) ||
    m.includes("error: az")
  ) {
    return [
      "AUTH — token Azure CLI indisponible.",
      "  1) az login   (puis choisir le compte @servicenow.com)",
      `  2) az account set --subscription "<tenant de ${instanceUrl}>"`,
      "Le serveur ré-acquiert un token à CHAQUE requête (voir src/dataverse.ts),",
      "donc chaque appel échouera tant que l'auth n'est pas faite.",
    ].join(EOL);
  }
  if (m.includes("401") || m.includes("unauthorized")) {
    return `AUTH — 401 sur ${instanceUrl} : token expiré ou mauvais tenant. Relancez "az login".`;
  }
  if (m.includes("403") || m.includes("forbidden")) {
    return `AUTH — 403 sur ${instanceUrl} : le compte n'a pas les droits sur cette instance.`;
  }
  if (m.includes("enotfound") || m.includes("getaddrinfo") || m.includes("network")) {
    return `RESEAU — impossible de joindre ${instanceUrl} (VPN / DNS ?).`;
  }
  return message;
}