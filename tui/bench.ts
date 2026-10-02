import { fmtBytes, fmtDuration, percentile } from "./metrics.ts";
import type { McpStdioClient } from "./mcpClient.ts";
import { humanizeAuthError } from "./mcpClient.ts";
import { computeStats } from "./metrics.ts";
import { Style, trunc, type Stream } from "./render.ts";
import type { CallRecord } from "./types.ts";

export interface BenchOptions {
  tool: string;
  args: Record<string, unknown>;
  runs: number;
  /** délai entre deux appels (ms) — utile pour ne pas saturer Dataverse. */
  delayMs: number;
  /** afficher une barre de progression sur stderr. */
  progress: boolean;
}

export interface BenchReport {
  tool: string;
  args: Record<string, unknown>;
  runs: number;
  ok: number;
  failed: number;
  durations: number[];
  stats: ReturnType<typeof computeStats>;
  /** durées des appels en échec uniquement (pour séparer auth/erreurs). */
  failures: Array<{ durationMs: number; error: string }>;
  /** octets échangés (args + résultats), cumulés. */
  bytes: number;
  wallMs: number;
}

/**
 * Mode watch/batch : rejoue le même appel N fois et rapporte la distribution
 * des durées.
 *
 * Pourquoi c'est utile ici : `src/dataverse.ts` crée un `AzureCliCredential`
 * ET un nouveau client axios à chaque appel. Chaque itération re-paye donc le
 * coût d'acquisition du token (`az account get-access-token`, ~200-600 ms) en
 * plus du aller-retour Dataverse. p50 vs min permet de séparer le coût fixe
 * d'auth de la latence réseau : si p50 >> min, l'auth domine.
 */
export async function runBench(
  client: McpStdioClient,
  opts: BenchOptions,
  onCall: (rec: CallRecord) => void,
  onInFlight: (delta: 1 | -1) => void
): Promise<BenchReport> {
  const style = new Style(process.stderr);
  const durations: number[] = [];
  const failures: Array<{ durationMs: number; error: string }> = [];
  let ok = 0;
  let bytes = 0;
  const wallStart = Date.now();

  for (let i = 1; i <= opts.runs; i++) {
    onInFlight(1);
    const outcome = await client.callTool(opts.tool, opts.args);
    onInFlight(-1);

    const argsBytes = JSON.stringify(opts.args).length;
    const rec: CallRecord = {
      seq: i,
      startedAt: Date.now() - outcome.durationMs,
      tool: opts.tool,
      ok: outcome.ok,
      durationMs: outcome.durationMs,
      error: outcome.error,
      argsBytes,
      resultBytes: outcome.resultBytes,
      tokens: Math.ceil((argsBytes + outcome.resultBytes) / 4),
    };
    onCall(rec);
    bytes += rec.argsBytes + rec.resultBytes;

    if (outcome.ok) {
      ok++;
      durations.push(outcome.durationMs);
    } else {
      failures.push({ durationMs: outcome.durationMs, error: outcome.error ?? "?" });
    }

    if (opts.progress) {
      const barW = 24;
      const filled = Math.round((i / opts.runs) * barW);
      const bar = "█".repeat(filled) + "░".repeat(barW - filled);
      const mark = outcome.ok ? style.green("OK") : style.red("ER");
      process.stderr.write(
        `\r  ${mark} [${bar}] ${i}/${opts.runs}  ${fmtDuration(outcome.durationMs)}  ` +
          style.dim(`moy ${fmtDuration(durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0)}`)
      );
    }
    if (opts.delayMs > 0 && i < opts.runs) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
  }
  if (opts.progress) process.stderr.write("\n");

  return {
    tool: opts.tool,
    args: opts.args,
    runs: opts.runs,
    ok,
    failed: failures.length,
    durations,
    stats: computeStats(durations),
    failures,
    bytes,
    wallMs: Date.now() - wallStart,
  };
}

/** Imprime un rapport de performance lisible. */
export function printBenchReport(
  report: BenchReport,
  instanceUrl: string,
  stream: Stream = process.stdout
): void {
  const style = new Style(stream);
  const s = report.stats;
  stream.write("\n");
  stream.write(style.boldCyan("═══ Rapport de performance ═══") + "\n");
  stream.write(`  outil     : ${style.cyan(report.tool)}\n`);
  stream.write(`  arguments : ${style.gray(trunc(JSON.stringify(report.args), 90))}\n`);
  stream.write(`  instance  : ${style.gray(instanceUrl)}\n`);
  stream.write(
    `  itérations: ${report.ok} réussies / ${report.failed} échouées (wall ${fmtDuration(report.wallMs)})\n`
  );

  if (report.durations.length > 0) {
    const sorted = [...report.durations].sort((a, b) => a - b);
    const line = [
      ["min", s.min],
      ["p50", percentile(sorted, 50)],
      ["p90", percentile(sorted, 90)],
      ["p95", percentile(sorted, 95)],
      ["p99", percentile(sorted, 99)],
      ["max", s.max],
      ["moy", s.avg],
    ] as Array<[string, number]>;
    stream.write("  durées    : " + line.map(([k, v]) => style.gray(k) + " " + fmtDuration(v)).join("  ") + "\n");

    // Diagnostic "auth vs réseau" : si l'écart p50-min est significatif,
    // le coût d'AzureCliCredential (re-acquis à chaque appel) est visible.
    const overhead = percentile(sorted, 50) - s.min;
    const ratio = s.min > 0 ? overhead / s.min : 0;
    stream.write(
      "  analyse   : " +
        (ratio > 0.4 && overhead > 80
          ? style.yellow(
              `écart p50-min = ${fmtDuration(overhead)} (${(ratio * 100).toFixed(0)}%) — ` +
              `coût d'auth AzureCliCredential dominant (src/dataverse.ts recrée le credential à chaque appel)`
            )
          : style.green("p50 proche du min — le coût auth n'est pas le facteur limitant (token probablement en cache)")) +
        "\n"
    );
    stream.write("  brut      : " + style.gray(report.durations.map((d) => `${Math.round(d)}ms`).join(" ")) + "\n");
  }

  if (report.failures.length > 0) {
    stream.write(style.boldRed("\n  Échecs :") + "\n");
    const grouped = new Map<string, number>();
    for (const f of report.failures) {
      const key = f.error.slice(0, 120);
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    for (const [msg, count] of grouped) {
      stream.write(`    ${style.red(`${count}×`)} ${style.gray(fmtDuration(report.failures[0].durationMs))} ` + trunc(msg, 80) + "\n");
      const hint = humanizeAuthError(msg, instanceUrl);
      if (hint !== msg) stream.write("      " + style.yellow(hint.replace(/\n/g, "\n      ")) + "\n");
    }
  }
  stream.write(style.gray(`  (trafic cumulé ${fmtBytes(report.bytes)})`) + "\n");
  stream.write("\n");
}

/** Watch : boucle continue avec rapport périodique (Ctrl+C pour quitter). */
export async function runWatch(
  client: McpStdioClient,
  opts: BenchOptions,
  onCall: (rec: CallRecord) => void,
  onInFlight: (delta: 1 | -1) => void,
  intervalRuns: number = opts.runs
): Promise<void> {
  const style = new Style(process.stderr);
  const runsPerReport = Math.max(1, intervalRuns);
  let cumulative: number[] = [];
  let cycle = 0;

  process.stderr.write(style.bold("\n── Mode watch (Ctrl+C pour arrêter) ──\n"));
  process.stderr.write(
    style.gray(`outil=${opts.tool} lot=${runsPerReport} délai=${opts.delayMs}ms\n`)
  );

  const onSigint = (): void => {
    process.stderr.write("\n" + style.gray("arrêt du watch demandé…\n"));
    process.exit(0);
  };
  process.on("SIGINT", onSigint);

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      cycle++;
      const report = await runBench(
        client,
        { ...opts, runs: runsPerReport, progress: false },
        onCall,
        onInFlight
      );
      cumulative = cumulative.concat(report.durations);
      const sorted = [...cumulative].sort((a, b) => a - b);
      process.stderr.write(
        `\n${style.bold(`cycle #${cycle}`)} ` +
          `${style.green(`${report.ok} ok`)} ${report.failed ? style.red(`${report.failed} ko`) : ""} ` +
          style.gray(`| cumul n=${cumulative.length} moy ${fmtDuration(sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1))}`) +
          ` p50 ${fmtDuration(percentile(sorted, 50))} ` +
          `p95 ${fmtDuration(percentile(sorted, 95))} ` +
          `min ${fmtDuration(sorted[0] ?? 0)}\n`
      );
      if (opts.delayMs > 0) await new Promise((r) => setTimeout(r, opts.delayMs));
    }
  } finally {
    process.off("SIGINT", onSigint);
    if (cumulative.length) {
      process.stderr.write("\n");
      printBenchReport(
        {
          tool: opts.tool,
          args: opts.args,
          runs: cumulative.length,
          ok: cumulative.length,
          failed: 0,
          durations: cumulative,
          stats: computeStats(cumulative),
          failures: [],
          bytes: 0,
          wallMs: 0,
        },
        "—",
        process.stderr
      );
    }
  }
}