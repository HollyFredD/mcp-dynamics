import type { LoadedConfig } from "./config.ts";
import { Dashboard } from "./dashboard.ts";
import { SessionLogger } from "./logger.ts";
import { McpStdioClient, humanizeAuthError } from "./mcpClient.ts";
import { Metrics } from "./metrics.ts";
import { Style } from "./render.ts";
import type { CallRecord, JsonRpcMessage, ServerState } from "./types.ts";

/**
 * Mode proxy : la TUI se place ENTRE un vrai client MCP (Claude Code, Claude
 * Desktop…) et le serveur `dist/index.js`, sans rien changer à l'un ou l'autre.
 *
 * C'est le seul moyen d'observer l'utilisation *réelle* (tokens, trafic, erreurs)
 * puisque le serveur n'émet aucune métrique. Le dashboard est rendu sur stderr
 * (stdout doit rester le canal JSON-RPC) ; à lancer via `--proxy` en remplaçant
 * `node dist/index.js` par `node --experimental-strip-types tui/index.ts --proxy`
 * dans la config MCP du client.
 */
export async function runProxy(
  cfg: LoadedConfig,
  logger: SessionLogger,
  argv: string[]
): Promise<void> {
  const metrics = new Metrics();
  const client = new McpStdioClient(cfg, logger);
  const state: { value: ServerState; crash: string | null } = {
    value: "connecting",
    crash: null,
  };
  const style = new Style(process.stderr);

  process.stderr.write(style.boldCyan("\nMCP Dynamics TUI — mode proxy (observabilité)\n"));
  process.stderr.write(
    style.gray("stdout = canal JSON-RPC (ne pas rediriger), dashboard sur stderr. Ctrl+C pour arrêter.\n")
  );

  client.onCrash = ({ code, signal }) => {
    state.value = "crashed";
    state.crash = `exit ${code}${signal ? ` (${signal})` : ""}`;
  };
  client.onStderr = (line) => {
    if (cfg.config.verbose) process.stderr.write(style.dim(`[srv] ${line}\n`));
  };

  // Démarrage du serveur réel + handshake (nécessaire pour valider la conf).
  try {
    await client.initialize();
    state.value = "ready";
  } catch (err) {
    process.stderr.write(style.boldRed(`handshake impossible: ${(err as Error).message}\n`));
    logger.error("proxy", `handshake: ${(err as Error).message}`);
    await client.stop();
    process.exit(1);
  }

  // Dashboard sur stderr, rafraîchissement périodique.
  const dashboard = new Dashboard(
    process.stderr,
    () => ({
      metrics,
      state: state.value,
      serverName: "mcp-dynamics",
      serverVersion: "1.0.0",
      toolCount: client.toolList.length,
      instanceUrl: cfg.instanceUrl,
      instanceSource: cfg.instanceSource,
      logFile: logger.file,
      stderrLines: client.stderrLines,
      sessionLabel: "proxy",
      crashInfo: state.crash,
      note: "proxy actif : ce qui est mesuré ici est l'usage par le client MCP en amont",
    }),
    cfg.config.dashboardIntervalMs
  );
  dashboard.start();

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) void handleLine(line);
    }
  });
  process.stdin.on("end", () => void shutdown("stdin fermé par le client"));

  /**
   * Opérations de forwarding en cours.
   *
   * Indispensable : quand le client externe ferme stdin (ou sur SIGTERM), on ne
   * doit pas tuer le serveur enfant tant que des `tools/call` n'ont pas rendu
   * leur réponse, sinon le client recevrait des erreurs « arrêt demandé » au lieu
   * de ses données.
   */
  let pendingOps = 0;
  let waiters: Array<() => void> = [];
  const drain = async (): Promise<void> => {
    while (pendingOps > 0) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };

  async function handleLine(line: string): Promise<void> {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      logger.error("proxy", `client a envoyé du non-JSON: ${line.slice(0, 120)}`);
      return;
    }

    // On ne relaie QUE ce qu'on sait mesurer : tools/call donne des métriques
    // exploitables (durée, tokens, erreurs). Les autres méthodes sont
    // transmises telles quelles pour ne pas casser le client.
    if (msg.method === "tools/call" && msg.id !== undefined) {
      const started = Date.now();
      pendingOps++;
      metrics.inflightStart();
      let res: JsonRpcMessage | undefined;
      try {
        res = await client.forward(msg);
      } finally {
        metrics.inflightEnd();
        pendingOps--;
        waiters.shift()?.();
      }
      const bytes = JSON.stringify(res ?? {}).length;
      const params = msg.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      const argsBytes = JSON.stringify(params?.arguments ?? {}).length;
      const result = res?.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
      const text = (result?.content ?? []).map((c) => c.text ?? "").join(" ").trim();
      const ok = !res?.error && !result?.isError;
      const errorMsg = res?.error?.message ?? (result?.isError ? text || "isError=true" : undefined);
      const rec: CallRecord = {
        seq: metrics.total + 1,
        startedAt: started,
        tool: params?.name ?? "?",
        ok,
        durationMs: Date.now() - started,
        error: errorMsg,
        argsBytes,
        resultBytes: bytes,
        tokens: Math.ceil((argsBytes + bytes) / 4),
      };
      metrics.record(rec);
      logger.log({ type: "call", record: rec });
      if (!ok) {
        const human = humanizeAuthError(errorMsg ?? "?", cfg.instanceUrl);
        process.stderr.write(style.yellow(`\n⚠ ${rec.tool}: ${human}\n`));
      }
      write(res);
      return;
    }

    write(await client.forward(msg));
  }

  function write(msg: JsonRpcMessage | undefined): void {
    if (!msg) return; // notification : rien à renvoyer
    process.stdout.write(JSON.stringify(msg) + "\n");
  }

  let closing = false;
  async function shutdown(reason: string): Promise<void> {
    if (closing) return;
    closing = true;
    // On laisse les requêtes déjà reçues se terminer avant de couper, pour que
    // le client externe obtienne ses réponses complètes.
    await drain();
    dashboard.stop();
    logger.close(reason);
    await client.stop();
    process.stderr.write(style.gray(`\nproxy arrêté (${reason})\n`));
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.error("proxy", `uncaught: ${err.message}`);
    process.stderr.write(style.boldRed(`uncaught: ${err.stack ?? err.message}\n`));
  });
  logger.info(`proxy démarré (argv: ${argv.join(" ")})`);
}