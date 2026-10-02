#!/usr/bin/env node
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline";
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  TUI_DIR,
  type TuiConfig,
} from "./config.ts";
import { RequestConsole } from "./console.ts";
import { Dashboard } from "./dashboard.ts";
import { formatToolResult } from "./format.ts";
import { SessionLogger, createNullLogger } from "./logger.ts";
import { printBenchReport, runBench, runWatch } from "./bench.ts";
import { humanizeAuthError, McpError, McpStdioClient } from "./mcpClient.ts";
import { fmtDuration, Metrics } from "./metrics.ts";
import { runProxy } from "./proxy.ts";
import { printReplaySummary, replayFile } from "./replay.ts";
import { Style, trunc, type Stream } from "./render.ts";
import type { CallRecord, ServerState } from "./types.ts";

type Command =
  | "tui"
  | "tools"
  | "call"
  | "bench"
  | "watch"
  | "replay"
  | "proxy"
  | "config"
  | "selftest"
  | "help";

interface CliOptions {
  command: Command;
  tool?: string;
  argsJson?: string;
  bench?: number;
  delay: number;
  replay?: string;
  set: Record<string, string>;
  verbose: boolean;
  noLog: boolean;
  noColor: boolean;
}

const USAGE = `
MCP Dynamics TUI — debug & observabilité du serveur MCP (zéro dépendance runtime)

USAGE
  npm run tui                              dashboard interactif (nécessite un TTY)
  npm run tui -- tools                     liste les outils exposés puis quitte
  npm run tui -- --tool <n> --args '<json>'  appel unique, affiche le résultat
  npm run tui -- --bench <n>               rejoue N fois + rapport de performance
  npm run tui -- --watch --tool <n>        boucle continue avec rapport périodique
  npm run tui -- --replay <fichier.ndjson>  analyse hors-ligne d'une session passée
  npm run tui -- --proxy                   s'intercale entre ton client MCP et le serveur
  npm run tui -- --config [k=v ...]        affiche / écrit tui/tui.config.json
  npm run tui -- --test                   tests de la logique pure (metrics, NLP, rendu)

OPTIONS
  --tool <nom>        outil à appeler
  --args '<json>'     arguments JSON de l'appel
  --bench <n>         nombre d'itérations (défaut: tui.config.json -> 10)
  --delay <ms>        pause entre deux itérations (défaut 0)
  --watch             mode boucle continue (équiv --bench 0)
  --replay <fichier>  fichier NDJSON de session à rejouer
  --server <chemin>   override du script serveur (défaut dist/index.js)
  --instance <url>    override de l'URL d'instance (défaut: détectée dans src/dataverse.ts)
  --timeout <ms>      timeout par requête (défaut 30000)
  --verbose           afficher le stderr du serveur
  --no-log            ne pas écrire de fichier NDJSON
  --no-color          désactiver les couleurs
  -h, --help          cette aide

RACCOURCIS CLAVIER (dashboard)
  c  console de requêtes      t  liste des outils
  r  relancer le serveur      e  erreurs récentes
  l  chemin du log NDJSON     w  watch sur le dernier outil
  ?  aide                     q  quitter

MODE PROXY
  Dans la config MCP du client, remplacer "node dist/index.js" par
  "node tui/index.ts --proxy" (après "npm run build"). La TUI relaie tout et
  journalise en NDJSON ; le dashboard s'affiche sur stderr.
`;

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    command: "tui",
    delay: 0,
    set: {},
    verbose: false,
    noLog: false,
    noColor: false,
  };
  const next = (i: number, flag: string): { value: string; i: number } => {
    const value = argv[i];
    if (value === undefined) {
      process.stderr.write(`argument manquant pour ${flag}\n`);
      process.exit(2);
    }
    return { value, i: i + 1 };
  };

  let i = 0;
  while (i < argv.length) {
    const a = argv[i++];
    switch (a) {
      case "-h":
      case "--help":
        opts.command = "help";
        break;
      case "--tools":
        opts.command = "tools";
        break;
      case "--call":
        opts.command = "call";
        break;
      case "--proxy":
        opts.command = "proxy";
        break;
      case "--config":
        opts.command = "config";
        break;
      case "--test":
      case "--selftest":
        opts.command = "selftest";
        break;
      case "--replay":
      case "-r": {
        const r = next(i, a);
        opts.replay = r.value;
        opts.command = "replay";
        i = r.i;
        break;
      }
      case "--watch":
        opts.command = "watch";
        break;
      case "--bench": {
        const r = next(i, a);
        const n = Number(r.value);
        opts.bench = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CONFIG.benchRuns;
        opts.command = "bench";
        i = r.i;
        break;
      }
      case "--tool": {
        const r = next(i, a);
        opts.tool = r.value;
        i = r.i;
        break;
      }
      case "--args": {
        const r = next(i, a);
        opts.argsJson = r.value;
        i = r.i;
        break;
      }
      case "--delay": {
        const r = next(i, a);
        opts.delay = Number(r.value) || 0;
        i = r.i;
        break;
      }
      case "--server":
      case "--instance":
      case "--timeout": {
        const r = next(i, a);
        const key = a === "--server" ? "serverPath" : a === "--instance" ? "instanceUrl" : "timeoutMs";
        opts.set[key] = r.value;
        i = r.i;
        break;
      }
      case "--verbose":
      case "-v":
        opts.verbose = true;
        break;
      case "--no-log":
        opts.noLog = true;
        break;
      case "--no-color":
        opts.noColor = true;
        break;
      default:
        if (a.startsWith("--")) {
          process.stderr.write(`option inconnue: ${a}\n${USAGE}`);
          process.exit(2);
        }
        // Argument positionnel : accepté comme raccourci de commande
        // (`npm run tui -- tools`, `-- watch`, ...) ou comme chemin de log.
        const KNOWN: Command[] = ["tui", "tools", "call", "bench", "watch", "replay", "proxy", "config", "help"];
        opts.set._ = a;
        if (a.endsWith(".ndjson") || a.endsWith(".jsonl")) {
          opts.replay = a;
          opts.command = "replay";
        } else if ((KNOWN as string[]).includes(a)) {
          opts.command = a as Command;
        }
    }
  }
  // --tool (avec ou sans --args), sans --bench/--watch => appel unique.
  if (opts.command === "tui" && opts.tool) opts.command = "call";
  return opts;
}

function buildOverrides(opts: CliOptions): Partial<TuiConfig> {
  const o: Partial<TuiConfig> = {};
  const set = opts.set;
  if (set.instanceUrl) o.instanceUrl = set.instanceUrl;
  if (set.serverPath) o.serverPath = set.serverPath;
  if (set.timeoutMs) {
    const n = Number(set.timeoutMs);
    if (Number.isFinite(n) && n > 0) o.timeoutMs = n;
  }
  if (opts.verbose || set.verbose) o.verbose = true;
  if (opts.noLog || set.logDir === "-") o.logDir = "";
  if (set.logDir) o.logDir = set.logDir;
  return o;
}

function makeLogger(opts: CliOptions, logDir: string, label: string): SessionLogger {
  if (opts.noLog || !logDir) return createNullLogger();
  return new SessionLogger(logDir, label);
}

/* ------------------------------------------------------------------ config */

function commandConfig(opts: CliOptions, stream: Stream): number {
  const style = new Style(stream);
  const loaded = loadConfig();
  const keys = Object.keys(opts.set).filter((k) => k !== "_");

  if (keys.length === 0) {
    stream.write(
      `${style.bold("Config effective")} ${style.gray(`(${CONFIG_PATH})`)}\n` +
        JSON.stringify({ ...loaded.config, instanceUrl: loaded.instanceUrl, instanceSource: loaded.instanceSource, serverPath: loaded.serverPath }, null, 2) +
        "\n"
    );
    return 0;
  }
  if (opts.set.init) {
    const p = saveConfig(DEFAULT_CONFIG);
    stream.write(style.green(`config réinitialisée: ${p}\n`));
    return 0;
  }

  const allowed: Array<keyof TuiConfig> = [
    "instanceUrl",
    "serverPath",
    "serverCommand",
    "timeoutMs",
    "benchRuns",
    "verbose",
    "logDir",
    "dashboardIntervalMs",
  ];
  const next = { ...loaded.config };
  for (const k of keys) {
    if (!allowed.includes(k as keyof TuiConfig)) {
      stream.write(style.red(`clé inconnue: ${k} (autorisé: ${allowed.join(", ")})\n`));
      return 2;
    }
    (next as Record<string, unknown>)[k] = /^-?\d+$/.test(opts.set[k])
      ? Number(opts.set[k])
      : opts.set[k];
  }
  const p = saveConfig(next);
  stream.write(style.green(`config écrite: ${p}\n`));
  return 0;
}

/* ------------------------------------------------------------------- outils */

async function commandTools(
  cfg: ReturnType<typeof loadConfig>,
  logger: SessionLogger,
  stream: Stream
): Promise<number> {
  const client = new McpStdioClient(cfg, logger);
  const style = new Style(stream);
  try {
    const { tools } = await client.initialize();
    stream.write(`\n${style.bold(`${tools.length} outils exposés par mcp-dynamics`)}\n\n`);
    const w = Math.max(...tools.map((t) => t.name.length));
    for (const t of tools) {
      const req = t.inputSchema?.required ?? [];
      stream.write(`  ${style.cyan(t.name.padEnd(w))}  ${style.gray(trunc(t.description ?? "", 80))}\n`);
      if (req.length) stream.write(`  ${" ".repeat(w)}  ${style.dim("requis: " + req.join(", "))}\n`);
    }
    stream.write("\n");
    return 0;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    stream.write(style.red(`échec du handshake: ${m}\n`));
    if (!cfg.serverExists) {
      stream.write(
        style.yellow(`Serveur introuvable: ${cfg.serverPath}\n→ lancez "npm run build" ou --server <chemin>\n`)
      );
    } else {
      stream.write(style.yellow(humanizeAuthError(m, cfg.instanceUrl)) + "\n");
    }
    return 1;
  } finally {
    await client.stop();
  }
}

/* --------------------------------------------------------------------- call */

async function commandCall(
  cfg: ReturnType<typeof loadConfig>,
  logger: SessionLogger,
  opts: CliOptions,
  stream: Stream
): Promise<number> {
  const client = new McpStdioClient(cfg, logger);
  const style = new Style(stream);
  if (!opts.tool) {
    stream.write(style.red("--tool <nom> est requis (voir --tools)\n"));
    return 2;
  }
  let args: Record<string, unknown> = {};
  if (opts.argsJson) {
    try {
      args = JSON.parse(opts.argsJson) as Record<string, unknown>;
    } catch (err) {
      stream.write(style.red(`--args JSON invalide: ${(err as Error).message}\n`));
      return 2;
    }
  }
  try {
    const { tools } = await client.initialize();
    if (!tools.some((t) => t.name === opts.tool)) {
      stream.write(
        style.red(`outil inconnu: ${opts.tool}\ndispo: ${tools.map((t) => t.name).join(", ")}\n`)
      );
      return 2;
    }
    stream.write(style.dim(`→ ${opts.tool} ${JSON.stringify(args)}`) + "\n");
    const out = await client.callTool(opts.tool, args);
    const argsBytes = JSON.stringify(args).length;
    logger.log({
      type: "call",
      record: {
        seq: 1,
        startedAt: Date.now() - out.durationMs,
        tool: opts.tool,
        ok: out.ok,
        durationMs: out.durationMs,
        error: out.error,
        argsBytes,
        resultBytes: out.resultBytes,
        tokens: Math.ceil((argsBytes + out.resultBytes) / 4),
      },
    });
    stream.write(
      (out.ok ? style.green(`✔ ${fmtDuration(out.durationMs)}`) : style.red(`✘ ${fmtDuration(out.durationMs)}`)) +
        "\n"
    );
    if (!out.ok) {
      stream.write(style.red(humanizeAuthError(out.error ?? "erreur inconnue", cfg.instanceUrl)) + "\n");
      return 1;
    }
    stream.write(formatToolResult(out.result) + "\n");
    return 0;
  } catch (err) {
    const m = err instanceof McpError ? err.message : (err as Error).message;
    stream.write(style.red(`échec: ${m}\n`));
    return 1;
  } finally {
    await client.stop();
  }
}

/* ------------------------------------------------------------- bench / watch */

async function commandBench(
  cfg: ReturnType<typeof loadConfig>,
  logger: SessionLogger,
  opts: CliOptions,
  watch: boolean,
  stream: Stream
): Promise<number> {
  const client = new McpStdioClient(cfg, logger);
  const style = new Style(stream);
  const metrics = new Metrics();

  let args: Record<string, unknown> = {};
  if (opts.argsJson) {
    try {
      args = JSON.parse(opts.argsJson) as Record<string, unknown>;
    } catch (err) {
      stream.write(style.red(`--args JSON invalide: ${(err as Error).message}\n`));
      return 2;
    }
  }

  const onCall = (rec: CallRecord): void => {
    metrics.record(rec);
    logger.log({ type: "call", record: rec });
  };
  const onInFlight = (delta: 1 | -1): void => {
    if (delta === 1) metrics.inflightStart();
    else metrics.inflightEnd();
  };

  try {
    const { tools } = await client.initialize();
    const tool = opts.tool ?? tools[0]?.name;
    if (!tool) {
      stream.write(style.red("aucun outil disponible (le serveur n'expose rien)\n"));
      return 1;
    }
    if (!tools.some((t) => t.name === tool)) {
      stream.write(style.red(`outil inconnu: ${tool}\ndispo: ${tools.map((t) => t.name).join(", ")}\n`));
      return 2;
    }
    if (args === undefined || Object.keys(args).length === 0) {
      // On pré-remplit les champs requis avec des valeurs "vides" : le serveur
      // renverra un message d'erreur explicite, plus parlant qu'un timeout.
      const schema = tools.find((t) => t.name === tool)?.inputSchema;
      for (const key of schema?.required ?? []) {
        const t = schema?.properties?.[key]?.type ?? "string";
        args[key] = t === "number" || t === "integer" ? 0 : t === "object" ? {} : t === "array" ? [] : "";
      }
    }

    const runs = opts.bench ?? cfg.config.benchRuns;
    stream.write(
      `${style.bold(watch ? "watch" : "bench")} ${style.cyan(tool)} ` +
        `${style.gray(`${watch ? "en boucle" : `x${runs}`} · ${cfg.instanceUrl} · timeout ${cfg.config.timeoutMs}ms`)}\n\n`
    );

    if (watch) {
      await runWatch(client, { tool, args, runs, delayMs: opts.delay, progress: false }, onCall, onInFlight, runs);
      return 0;
    }
    const report = await runBench(
      client,
      { tool, args, runs, delayMs: opts.delay, progress: true },
      onCall,
      onInFlight
    );
    printBenchReport(report, cfg.instanceUrl, stream);
    stream.write(style.gray(`log NDJSON: ${logger.file ?? "(désactivé)"}\n`));
    // 100% d'échecs => code retour 1 (utile en CI).
    return report.ok === 0 && report.failed > 0 ? 1 : 0;
  } catch (err) {
    const m = err instanceof McpError ? err.message : (err as Error).message;
    stream.write(style.red(`échec: ${m}\n`));
    return 1;
  } finally {
    await client.stop();
  }
}

/* ------------------------------------------------------------ interactif TTY */

async function runInteractive(
  cfg: ReturnType<typeof loadConfig>,
  logger: SessionLogger
): Promise<number> {
  const client = new McpStdioClient(cfg, logger);
  const metrics = new Metrics();
  const style = new Style(process.stdout);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  const st: { state: ServerState; crash: string | null; lastTool: string | null; note?: string } = {
    state: "connecting",
    crash: null,
    lastTool: null,
  };

  const record = (rec: CallRecord): void => {
    metrics.record(rec);
    logger.log({ type: "call", record: rec });
    st.lastTool = rec.tool;
  };
  const inFlight = (d: 1 | -1): void => (d === 1 ? metrics.inflightStart() : metrics.inflightEnd());

  logger.log({
    type: "session_start",
    pid: process.pid,
    argv: process.argv.slice(2),
    config: {
      instanceUrl: cfg.instanceUrl,
      instanceSource: cfg.instanceSource,
      serverPath: cfg.serverPath,
      timeoutMs: cfg.config.timeoutMs,
      verbose: cfg.config.verbose,
      dashboardIntervalMs: cfg.config.dashboardIntervalMs,
    },
  });

  let dashboard: Dashboard | null = null;
  client.onCrash = ({ code, signal }) => {
    st.state = "crashed";
    st.crash = `code ${code}${signal ? ` signal ${signal}` : ""}`;
    logger.error("server", `crash: ${st.crash}`);
    dashboard?.draw(true);
  };
  client.onStderr = (line) => {
    if (cfg.config.verbose && !interactive) process.stderr.write(style.dim(`[srv] ${line}\n`));
  };

  // --- Connexion ----------------------------------------------------------
  let connectError: string | null = null;
  try {
    await client.initialize();
    st.state = "ready";
    logger.info(`serveur prêt, ${client.toolList.length} outils`);
  } catch (err) {
    st.state = "crashed";
    st.crash = (err as Error).message;
    connectError = (err as Error).message;
    logger.error("connect", connectError);
  }

  const console_ = new RequestConsole(process.stdout, client, cfg, record, inFlight);

  // --- Mode non-TTY : REPL en ligne, lisible par un humain ou un script ----
  if (!interactive) {
    process.stdout.write(style.bold("MCP Dynamics TUI — mode non-TTY (stdin non interactif)\n"));
    process.stdout.write(`  état    : ${st.state}${connectError ? ` — ${connectError}` : ""}\n`);
    process.stdout.write(`  outils  : ${client.toolList.length}\n`);
    process.stdout.write(`  instance: ${cfg.instanceUrl} (${cfg.instanceSource})\n`);
    process.stdout.write(`  log     : ${logger.file ?? "(désactivé)"}\n`);
    if (connectError) {
      process.stdout.write(style.yellow("  " + humanizeAuthError(connectError, cfg.instanceUrl).replace(/\n/g, "\n  ")) + "\n");
    }
    process.stdout.write(
      style.gray(
        "\ncommandes stdin : tools | schema <outil> | call <outil> '<json>' | " +
          "bench <outil> <n> | use <outil> | <phrase en langage naturel> | quit\n\n"
      )
    );

    // On lit stdin en entier AVANT de traiter : en mode pipe, une seconde
    // interface readline (celle de la console, pour les confirmations) entrerait
    // en concurrence avec la boucle principale sur le même flux. Un curseur
    // partagé évite ce problème et garde un comportement déterministe en script.
    const iface = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    const pending: string[] = [];
    for await (const line of iface) pending.push(line);
    iface.close();

    let cursor = 0;
    const nextLine = (question: string): Promise<string> => {
      // Les questions sont rendues sur stdout pour que le script sache quoi
      // répondre ; une entrée vide reste une réponse valide (valeur par défaut).
      process.stdout.write(question + " ");
      const v = cursor < pending.length ? pending[cursor++] : "";
      return Promise.resolve(v);
    };
    console_.askOverride = nextLine;

    while (cursor < pending.length) {
      const cmd = pending[cursor++].trim();
      if (!cmd) continue;
      if (cmd === "quit" || cmd === "exit") break;
      if (cmd.startsWith("bench ")) {
        const parts = cmd.split(/\s+/);
        const t = parts[1];
        const n = Number(parts[2] ?? cfg.config.benchRuns);
        if (t) {
          const report = await runBench(
            client,
            { tool: t, args: {}, runs: Number.isFinite(n) ? n : 5, delayMs: 0, progress: false },
            record,
            inFlight
          );
          printBenchReport(report, cfg.instanceUrl, process.stdout);
        }
        continue;
      }
      await console_.dispatch(cmd);
    }
    logger.close("non-tty: fin de stdin");
    await client.stop();
    return 0;
  }

  // --- Dashboard + clavier ------------------------------------------------
  // Résolveur de la promesse d'attente du dashboard (déclenché par « q »).
  let quitResolve: () => void = () => {};

  dashboard = new Dashboard(
    process.stdout,
    () => ({
      metrics,
      state: st.state,
      serverName: "mcp-dynamics",
      serverVersion: "1.0.0",
      toolCount: client.toolList.length,
      instanceUrl: cfg.instanceUrl,
      instanceSource: cfg.instanceSource,
      logFile: logger.file,
      stderrLines: client.stderrLines,
      sessionLabel: "interactif",
      crashInfo: st.crash,
      note: st.note,
    }),
    cfg.config.dashboardIntervalMs
  );
  dashboard.start();
  if (connectError) st.note = humanizeAuthError(connectError, cfg.instanceUrl);
  dashboard.draw(true);

  // Le dashboard occupe tout l'écran : on passe stdin en mode "raw" pour lire
  // les touches une par une, et on rend la main à readline pour la console.
  emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  let inConsole = false;

  const suspend = (): void => {
    dashboard!.stop();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  };
  const resume = (): void => {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    dashboard!.start();
    dashboard!.draw(true);
  };

  const quit = async (): Promise<void> => {
    process.stdin.off("keypress", onKeypress);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    dashboard!.stop();
    logger.close("quitter");
    await client.stop();
    process.stdout.write(style.gray("à bientôt.\n"));
    quitResolve();
    process.exit(0);
  };

  const restart = async (): Promise<void> => {
    suspend();
    st.state = "connecting";
    st.crash = null;
    st.note = "redémarrage du serveur…";
    await client.stop();
    try {
      await client.initialize();
      st.state = "ready";
      st.note = "serveur relancé";
      logger.info("serveur relancé");
    } catch (err) {
      st.state = "crashed";
      st.crash = (err as Error).message;
      st.note = humanizeAuthError((err as Error).message, cfg.instanceUrl);
      logger.error("restart", (err as Error).message);
    }
    resume();
  };

  /** Ouvre la console de requêtes (mode « pleine page », dashboard suspendu). */
  const openConsole = async (prefill?: string): Promise<void> => {
    suspend();
    inConsole = true;
    process.stdout.write(style.gray("\n(« up » ou Ctrl+C pour revenir au dashboard)\n"));
    await console_.loop(prefill);
    inConsole = false;
    // readline met stdin en pause à la fermeture : sans ce resume explicite,
    // les événements 'keypress' ne repartiraient jamais et le dashboard
    // resterait figé jusqu'au Ctrl+C suivant.
    process.stdin.resume();
    resume();
  };

  function onKeypress(_str: string | undefined, key: { name?: string }): void {
    if (inConsole) return;
    switch (key.name) {
      case "q":
        void quit();
        break;
      case "c":
        void openConsole();
        break;
      case "t":
        // On réutilise la console : elle gère l'affichage de la liste et le
        // retour au dashboard quand l'utilisateur tape « up ».
        void openConsole("tools");
        break;
      case "r":
        void restart();
        break;
      case "e": {
        const errs = metrics.recentErrors;
        st.note = errs.length
          ? errs
              .slice(-3)
              .reverse()
              .map((e) => `${e.tool}: ${e.message}`)
              .join("  |  ")
          : "aucune erreur enregistrée";
        dashboard!.draw(true);
        break;
      }
      case "l":
        st.note = `log NDJSON: ${logger.file ?? "(désactivé — --no-log)"}`;
        dashboard!.draw(true);
        break;
      case "w":
        st.note = st.lastTool
          ? `pour rejouer ${st.lastTool} en boucle : npm run tui -- --watch --tool ${st.lastTool}`
          : "aucun outil appelé pour l'instant — utilisez « c » (console)";
        dashboard!.draw(true);
        break;
      case "?":
      case "h":
        st.note = "c=console  t=outils  r=relancer  e=erreurs  l=log  w=watch  ?=aide  q=quitter";
        dashboard!.draw(true);
        break;
      default:
        break;
    }
  }
  process.stdin.on("keypress", onKeypress);

  process.on("SIGINT", () => void quit());
  process.on("SIGTERM", () => void quit());
  process.on("uncaughtException", (err) => {
    logger.error("tui", `uncaught: ${err.message}`);
    st.note = `erreur interne: ${err.message}`;
    try {
      dashboard!.draw(true);
    } catch {
      /* terminal gone */
    }
  });

  // Le dashboard tourne tout seul jusqu'à « q » / Ctrl+C.
  await new Promise<void>((resolve) => {
    quitResolve = resolve;
  });
  return 0;
}

/* ------------------------------------------------------------------- main */

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.noColor) process.env.NO_COLOR = "1";

  if (opts.command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (opts.command === "selftest") {
    // Import dynamique : le test n'est chargé que si on le demande, et il
    // positionne lui-même process.exitCode selon le résultat.
    await import("./test-nlp.ts");
    return 0;
  }
  if (opts.command === "config") return commandConfig(opts, process.stdout);
  if (opts.command === "replay") {
    if (!opts.replay) {
      process.stderr.write("usage: npm run tui -- --replay <fichier.ndjson>\n");
      return 2;
    }
    try {
      printReplaySummary(replayFile(opts.replay), process.stdout);
      return 0;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  const cfg = loadConfig(buildOverrides(opts));

  if (opts.command === "proxy") {
    await runProxy(cfg, makeLogger(opts, cfg.config.logDir || TUI_DIR, "proxy"), process.argv.slice(2));
    return 0;
  }

  if (!cfg.serverExists) {
    process.stderr.write(
      `Serveur introuvable: ${cfg.serverPath}\n→ "npm run build" (produit dist/index.js) ou --server <chemin>\n`
    );
    if (opts.command !== "tui") return 1;
    // En mode interactif on continue pour pouvoir afficher l'erreur et allow
    // de changer de serveur via --server.
  }

  const logger = makeLogger(opts, cfg.config.logDir, opts.command);

  try {
    switch (opts.command) {
      case "tools":
        return await commandTools(cfg, logger, process.stdout);
      case "call":
        return await commandCall(cfg, logger, opts, process.stdout);
      case "bench":
        return await commandBench(cfg, logger, opts, false, process.stdout);
      case "watch":
        return await commandBench(cfg, logger, opts, true, process.stdout);
      default:
        return await runInteractive(cfg, logger);
    }
  } finally {
    // Close() wrote l'événement session_end : indispensable pour que `--replay`
    // puisse dater la fin de session (flush sur process.exit).
    logger.close(opts.command);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`\n[tui] erreur fatale: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  });

// Point d'entrée : rien n'est exporté. `export {}` force le module ESM.
export {};