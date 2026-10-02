import { printBenchReport, runBench } from "./bench.ts";
import { clampText, compactLine, formatToolResult } from "./format.ts";
import type { McpStdioClient, CallOutcome } from "./mcpClient.ts";
import { humanizeAuthError } from "./mcpClient.ts";
import type { LoadedConfig } from "./config.ts";
import { fmtDuration } from "./metrics.ts";
import { guessToolCall, normalize } from "./nlp.ts";
import { Prompter } from "./prompt.ts";
import { padEnd, Style, trunc, type Stream } from "./render.ts";
import type { CallRecord, JsonSchema, McpTool } from "./types.ts";

/**
 * Console de requêtes — mode « ligne de commande » hors dashboard.
 *
 * Deux façons de saisir une requête :
 *  1) langage naturel -> heuristique locale (tui/nlp.ts) qui propose un
 *     tools/call, affiché et confirmé avant exécution ;
 *  2) `use <outil>` -> formulaire construit dynamiquement à partir des JSON
 *     schemas exposés par `tools/list` (types, required, enum, descriptions).
 *
 * Toutes les écritures passent par `run()` qui alimente les métriques + le log.
 */
export class RequestConsole {
  private readonly style: Style;
  private readonly prompter: Prompter;
  private readonly out: Stream;
  private readonly client: McpStdioClient;
  private readonly cfg: LoadedConfig;
  private readonly onCall: (rec: CallRecord) => void;
  private readonly onInFlight: (delta: 1 | -1) => void;
  private running = true;
  /**
   * Source des questions en mode non-TTY (pipe / script) : au lieu d'ouvrir un
   * second readline — qui entrerait en concurrence avec la boucle principale
   * sur le même stdin — on consomme la ligne suivante du flux déjà lu.
   */
  askOverride: ((question: string) => Promise<string>) | null = null;

  /**
   * Pose une question. Délègue à l'override (mode pipe) ou au Prompter (TTY).
   */
  private async askRaw(question: string): Promise<string> {
    if (this.askOverride) return this.askOverride(question);
    return this.prompter.askRaw(question);
  }

  /** Idem, avec valeur par défaut (utilisé par le formulaire d'arguments). */
  private async ask(question: string, defaultValue?: string): Promise<string> {
    if (this.askOverride) return this.askOverride(question);
    return this.prompter.ask(question, defaultValue);
  }

  // Champs déclarés explicitement (pas de "parameter properties") pour rester
  // compatible avec le mode strip-only de Node, qui n'accepte pas cette syntaxe.
  constructor(
    out: Stream,
    client: McpStdioClient,
    cfg: LoadedConfig,
    onCall: (rec: CallRecord) => void,
    onInFlight: (delta: 1 | -1) => void
  ) {
    this.out = out;
    this.client = client;
    this.cfg = cfg;
    this.onCall = onCall;
    this.onInFlight = onInFlight;
    this.style = new Style(out);
    this.prompter = new Prompter();
  }

  private say(s: string): void {
    this.out.write(s + "\n");
  }

  private hint(s: string): void {
    this.say(this.style.gray(s));
  }

  /** Affiche la liste des outils (format tabulaire compact). */
  listTools(tools: McpTool[]): void {
    if (tools.length === 0) {
      this.say(this.style.yellow("Aucun outil exposé par le serveur."));
      return;
    }
    const w = Math.max(...tools.map((t) => t.name.length));
    this.say(this.style.bold(`${tools.length} outils disponibles :`));
    for (const t of tools) {
      const req = t.inputSchema?.required ?? [];
      this.say(
        `  ${this.style.cyan(padEnd(t.name, w))}  ` +
          this.style.dim(trunc(t.description ?? "", Math.max(40, (process.stdout.columns ?? 100) - w - 8)))
      );
      if (req.length) this.hint(`    ${" ".repeat(w)}  requis: ${req.join(", ")}`);
    }
  }

  /** Affiche le JSON schema d'un outil. */
  showSchema(name: string): void {
    const tool = this.client.toolList.find((t) => t.name === name);
    if (!tool) {
      this.say(this.style.red(`Outil inconnu: ${name}`));
      return;
    }
    this.say(this.style.bold(`\n${tool.name}`));
    this.say(tool.description ?? "");
    this.say(this.style.bold("inputSchema:"));
    this.say(JSON.stringify(tool.inputSchema ?? {}, null, 2));
  }

  /**
   * Exécute un tools/call et journalise (durée, erreurs, octets, tokens).
   * Retourne l'outcome pour l'affichage console.
   */
  private async run(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<CallOutcome> {
    const seq = Date.now() % 1_000_000;
    const argsBytes = JSON.stringify(args).length;
    this.onInFlight(1);
    let outcome: CallOutcome;
    try {
      outcome = await this.client.callTool(name, args, timeoutMs);
    } finally {
      this.onInFlight(-1);
    }
    // Estimation tokens ~ 4 caractères/token sur l'échange complet.
    const tokens = Math.ceil((argsBytes + outcome.resultBytes) / 4);
    const rec: CallRecord = {
      seq,
      startedAt: Date.now() - outcome.durationMs,
      tool: name,
      ok: outcome.ok,
      durationMs: outcome.durationMs,
      error: outcome.error,
      argsBytes,
      resultBytes: outcome.resultBytes,
      tokens,
    };
    this.onCall(rec);

    const head = outcome.ok
      ? this.style.green(`✔ ${name}`) + ` ${this.style.dim(fmtDuration(outcome.durationMs))}`
      : this.style.boldRed(`✘ ${name}`) + ` ${this.style.dim(fmtDuration(outcome.durationMs))}`;
    this.say(head);
    if (!outcome.ok) {
      this.say(
        this.style.red(
          "  " + humanizeAuthError(outcome.error ?? "erreur inconnue", this.cfg.instanceUrl)
        )
      );
    }
    return outcome;
  }

  /** Affiche le résultat d'un tools/call proprement (JSON replié, tronqué). */
  private printResult(outcome: CallOutcome, maxLines = 60): void {
    if (!outcome.result) return;
    const formatted = formatToolResult(outcome.result, { maxItems: 50, maxString: 1000 });
    this.say(clampText(formatted, maxLines, 120_000));
  }

  /** Boucle interactive de la console. Résout quand l'utilisateur sort. */
  async loop(prefill?: string): Promise<void> {
    this.running = true;
    this.say("");
    this.say(this.style.boldCyan("── Console de requêtes ──"));
    this.hint("Commandes : <phrase en langage naturel> | tools | use <outil> | call <outil> '<json>'");
    this.hint("           bench <outil> [n] | schema <outil> | up (retour dashboard) | ? aide");
    this.say("");

    // Commande pré-remplie (utilisée par la touche « t » du dashboard).
    if (prefill) await this.dispatch(prefill);

    while (this.running) {
      let input: string;
      try {
        input = await this.askRaw(this.style.bold("mcp> "));
      } catch {
        break; // stdin fermé (Ctrl+D)
      }
      input = input.trim();
      if (!input) continue;
      try {
        await this.dispatch(input);
      } catch (err) {
        this.say(this.style.red(`erreur interne: ${(err as Error).message}`));
      }
    }
    this.prompter.close();
  }

  /** Quitte la boucle (touche `up` / `:q`). */
  stop(): void {
    this.running = false;
  }

  /** Route une ligne de commande. */
  async dispatch(line: string): Promise<void> {
    const lower = line.toLowerCase();

    if (lower === "help" || lower === "?") return this.help();
    if (lower === "tools" || lower === "ls") return this.listTools(this.client.toolList);
    if (lower.startsWith("schema ")) return this.showSchema(line.slice(7).trim());
    if (lower === "up" || lower === ":q" || lower === "back" || lower === "exit") {
      this.stop();
      return;
    }
    if (lower.startsWith("call ")) {
      const rest = line.slice(5).trim();
      const sp = rest.indexOf(" ");
      const name = sp === -1 ? rest : rest.slice(0, sp);
      const argsRaw = sp === -1 ? "{}" : rest.slice(sp + 1).trim();
      let args: Record<string, unknown>;
      try {
        args = argsRaw ? (JSON.parse(argsRaw) as Record<string, unknown>) : {};
      } catch (err) {
        this.say(this.style.red(`JSON invalide: ${(err as Error).message}`));
        return;
      }
      const outcome = await this.run(name, args);
      return this.printResult(outcome);
    }
    if (lower.startsWith("use ")) {
      const name = line.slice(4).trim();
      const args = await this.formFor(name);
      if (!args) return;
      const outcome = await this.run(name, args);
      return this.printResult(outcome);
    }
    if (lower.startsWith("bench ")) {
      // Raccourci de mesure depuis la console : `bench <outil> [n]` rejoue
      // l'appel n fois et affiche le rapport (même chemin que --bench).
      const parts = line.split(/\s+/);
      const tool = parts[1];
      const runs = Number(parts[2] ?? 5);
      if (!tool) {
        this.say(this.style.red("usage: bench <outil> [nb_iterations]"));
        return;
      }
      if (!this.client.toolList.some((t) => t.name === tool)) {
        this.say(this.style.red(`outil inconnu: ${tool}`));
        return;
      }
      const n = Number.isFinite(runs) && runs > 0 ? Math.min(runs, 200) : 5;
      this.say(this.style.dim(`bench ${tool} x${n}…`));
      const report = await runBench(
        this.client,
        { tool, args: {}, runs: n, delayMs: 0, progress: false },
        this.onCall,
        this.onInFlight
      );
      return printBenchReport(report, this.cfg.instanceUrl, this.out);
    }
    // fallback : langage naturel -> proposition d'appel
    await this.naturalLanguage(line);
  }

  private help(): void {
    this.say(this.style.bold("\nAide :"));
    this.say("  <phrase>          ex. 'opportunités du trimestre 26-Q3'  -> propose un tools/call");
    this.say("  tools             liste les outils exposés par le serveur");
    this.say("  use <outil>       formulaire interactif d'arguments (schéma JSON)");
    this.say("  call <outil> <json>  appel direct");
    this.say("  bench <outil> [n] rejoue l'appel n fois + rapport de performance");
    this.say("  schema <outil>    affiche le JSON schema d'un outil");
    this.say("  up                retour au dashboard");
  }

  /** Formulaire interactif construit depuis le JSON schema d'un outil. */
  private async formFor(name: string): Promise<Record<string, unknown> | null> {
    const tool = this.client.toolList.find((t) => t.name === name);
    if (!tool) {
      this.say(this.style.red(`Outil inconnu: ${name} (tapez 'tools')`));
      return null;
    }
    const schema = tool.inputSchema ?? {};
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const args: Record<string, unknown> = {};

    this.say(this.style.bold(`\nFormulaire — ${name}`));
    this.hint(trunc(tool.description ?? "", 120));

    for (const [key, prop] of Object.entries(props)) {
      const p = prop as JsonSchema;
      // Un champ optionnel peut être sauté avec une entrée vide si une valeur
      // par défaut existe ou s'il est requis (pas de défaut => on demande).
      const typeLabel = p.type === "array" ? `${p.type}<${p.items?.type ?? "?"}>` : (p.type ?? "?");
      const req = required.has(key) ? "*" : " ";
      const hintText = p.enum
        ? `choix: ${p.enum.join(" | ")}`
        : p.description
          ? trunc(p.description, 70)
          : "";
      this.hint(`  [${req}] ${key} (${typeLabel}) ${this.style.dim(hintText)}`);
      const raw = await this.ask(`    ${key}`, p.default !== undefined ? String(p.default) : undefined);
      if (raw === "") {
        if (required.has(key)) {
          // On met une chaîne vide puis on laisse le serveur valider -> message clair.
          args[key] = "";
        }
        continue;
      }
      args[key] = coerceToSchema(p, raw);
    }
    return args;
  }

  /**
   * Langage naturel : on propose un appel, on l'affiche, on demande confirmation.
   * Rien n'est exécuté sans validation explicite.
   */
  private async naturalLanguage(line: string): Promise<void> {
    const guess = guessToolCall(line, this.client.toolList);
    if (!guess) {
      this.say(this.style.yellow(`Je n'ai pas su mapper « ${compactLine(line, 60)} » sur un outil.`));
      this.hint("Essayez 'tools' pour la liste, ou 'use <outil>' pour un formulaire, ou 'call <outil> '<json>'.");
      return;
    }
    this.say(
      this.style.bold("Proposition : ") +
        this.style.cyan(guess.tool) +
        this.style.dim(`  (confiance ${(guess.confidence * 100).toFixed(0)}% — ${guess.why})`)
    );
    this.say(this.style.gray("  arguments : ") + JSON.stringify(guess.args));
    const ans = (await this.askRaw(this.style.bold("  [o]ui / [n]on / [e]diter : "))).trim().toLowerCase();
    if (ans === "n" || ans === "non") {
      this.say(this.style.dim("  annulé."));
      return;
    }
    if (ans === "e" || ans === "editer" || ans === "edit") {
      const edited = await this.ask("  arguments JSON", JSON.stringify(guess.args));
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(edited) as Record<string, unknown>;
      } catch (err) {
        this.say(this.style.red(`  JSON invalide, appel annulé: ${(err as Error).message}`));
        return;
      }
      const outcome = await this.run(guess.tool, args);
      return this.printResult(outcome);
    }
    // Par défaut : oui si l'utilisateur tape Enter (comportement MCP/CLI classique).
    const outcome = await this.run(guess.tool, guess.args);
    return this.printResult(outcome, 80);
  }
}

/** Convertit une saisie texte vers le type du JSON schema. */
function coerceToSchema(p: JsonSchema, raw: string): unknown {
  const t = p.type;
  if (t === "number" || t === "integer") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (t === "boolean") {
    return /^(1|true|oui|yes|vrai|y)$/i.test(raw.trim());
  }
  if (t === "array") {
    // Accepte `a,b,c` ou `["a","b"]`
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        /* tombe dans le split */
      }
    }
    return trimmed.split(",").map((x) => x.trim()).filter(Boolean);
  }
  if (t === "object") {
    const trimmed = raw.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

export { normalize }; // ré-export pratique pour les tests / le proxy