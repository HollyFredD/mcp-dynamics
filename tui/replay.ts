import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { computeStats, fmtBytes, fmtDuration, fmtNum, fmtUptime } from "./metrics.ts";
import { sparkline, Style, trunc, verticalBars, type Stream } from "./render.ts";
import type { CallRecord, LogEvent } from "./types.ts";

export interface ReplaySummary {
  file: string;
  /** durée de la session rejouée (premier → dernier événement). */
  sessionMs: number;
  calls: CallRecord[];
  errors: Array<{ ts: number; tool: string; message: string }>;
  stderrLines: string[];
  /** exit code du serveur s'il a été journalisé. */
  exit: { code: number | null; signal: string | null } | null;
  /** méthodes JSON-RPC vues, avec leur durée. */
  rpc: Array<{ method: string; durationMs: number; ok: boolean }>;
  config: Record<string, unknown> | null;
  reason: string | null;
}

/**
 * Analyse hors-ligne d'un log NDJSON produit par une session précédente.
 *
 * Permet de comparer deux sessions (ex. avant/après ajout d'un cache de token)
 * sans avoir à rejouer, et de garder la trace d'une session qui a crashé.
 */
export function replayFile(file: string): ReplaySummary {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`fichier de log introuvable: ${path}`);

  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const calls: CallRecord[] = [];
  const errors: ReplaySummary["errors"] = [];
  const stderrLines: string[] = [];
  const rpcById = new Map<number, { method: string; ts: number }>();
  const rpc: ReplaySummary["rpc"] = [];
  let firstTs = Infinity;
  let lastTs = -Infinity;
  let exit: ReplaySummary["exit"] = null;
  let config: Record<string, unknown> | null = null;
  let reason: string | null = null;

  for (const [i, line] of lines.entries()) {
    let ev: LogEvent & { seq?: number };
    try {
      ev = JSON.parse(line) as LogEvent & { seq?: number };
    } catch {
      // Une ligne tronquée (kill -9 pendant l'écriture) ne doit pas tout casser.
      errors.push({ ts: 0, tool: "log", message: `ligne ${i + 1} illisible` });
      continue;
    }
    if (typeof ev.ts === "number") {
      firstTs = Math.min(firstTs, ev.ts);
      lastTs = Math.max(lastTs, ev.ts);
    }
    switch (ev.type) {
      case "session_start":
        config = ev.config;
        break;
      case "session_end":
        reason = ev.reason;
        break;
      case "server_exit":
        exit = { code: ev.code, signal: ev.signal };
        break;
      case "stderr":
        stderrLines.push(ev.line);
        break;
      case "rpc_request":
        rpcById.set(ev.id, { method: ev.method, ts: ev.ts });
        break;
      case "rpc_response":
        rpc.push({
          method: rpcById.get(ev.id)?.method ?? "?",
          durationMs: ev.durationMs,
          ok: ev.ok,
        });
        break;
      case "call":
        calls.push(ev.record);
        if (!ev.record.ok && ev.record.error) {
          errors.push({ ts: ev.ts, tool: ev.record.tool, message: ev.record.error });
        }
        break;
      case "error":
        errors.push({ ts: ev.ts, tool: ev.scope, message: ev.message });
        break;
      default:
        break;
    }
  }

  return {
    file: basename(path),
    sessionMs: lastTs > 0 && firstTs !== Infinity ? lastTs - firstTs : 0,
    calls,
    errors,
    stderrLines,
    exit,
    rpc,
    config,
    reason,
  };
}

export function printReplaySummary(
  s: ReplaySummary,
  stream: Stream = process.stdout
): void {
  const style = new Style(stream);
  const stats = computeStats(
    s.calls.map((c) => c.durationMs),
    s.calls.reduce((n, c) => n + c.tokens, 0),
    s.calls.reduce((n, c) => n + c.argsBytes + c.resultBytes, 0)
  );
  const errCount = s.calls.filter((c) => !c.ok).length;

  stream.write("\n");
  stream.write(style.boldCyan("═══ Analyse hors-ligne (replay) ═══") + "\n");
  stream.write(`  fichier  : ${style.cyan(s.file)}\n`);
  stream.write(`  durée    : ${fmtUptime(s.sessionMs)}   fin: ${s.reason ?? "?"}\n`);
  if (s.exit) {
    const clean = s.exit.code === 0 || (s.exit.code === null && !!s.exit.signal);
    stream.write(
      `  serveur  : ` +
        (clean
          ? style.green(`arrêté (${s.exit.signal ? "signal " + s.exit.signal : "code 0"})`)
          : style.red(`exit ${s.exit.code}${s.exit.signal ? " signal " + s.exit.signal : ""}`)) +
        "\n"
    );
  }
  if (s.config) {
    const c = s.config as Record<string, unknown>;
    stream.write(
      `  config   : ${style.gray(`instance=${c.instanceUrl ?? "?"} timeout=${c.timeoutMs ?? "?"} verbose=${c.verbose ?? "?"}`)}\n`
    );
  }
  stream.write(
    `  appels   : ${stats.count} (${errCount} erreurs, taux ${stats.count ? ((errCount / stats.count) * 100).toFixed(1) : "0"}%)\n`
  );
  stream.write(
    `  durées   : min ${fmtDuration(stats.min)} · moy ${fmtDuration(stats.avg)} · p50 ${fmtDuration(stats.p50)} · p95 ${fmtDuration(stats.p95)} · max ${fmtDuration(stats.max)}\n`
  );
  stream.write(`  trafic   : ${fmtBytes(stats.bytes)} · tokens≈ ${fmtNum(stats.tokens)}\n`);

  // Répartition par outil
  const byTool = new Map<string, number[]>();
  for (const c of s.calls) {
    const l = byTool.get(c.tool);
    if (l) l.push(c.durationMs);
    else byTool.set(c.tool, [c.durationMs]);
  }
  if (byTool.size) {
    stream.write("\n  " + style.bold("par outil :") + "\n");
    const rows = [...byTool.entries()]
      .map(([tool, d]) => ({ tool, n: d.length, avg: d.reduce((a, b) => a + b, 0) / d.length, max: Math.max(...d) }))
      .sort((a, b) => b.n - a.n);
    const w = Math.max(...rows.map((r) => r.tool.length));
    for (const r of rows) {
      stream.write(
        `    ${style.cyan(r.tool.padEnd(w))}  n=${String(r.n).padStart(3)}  moy ${fmtDuration(r.avg).padStart(8)}  max ${fmtDuration(r.max).padStart(8)}\n`
      );
    }
  }

  // Timeline
  if (s.calls.length > 0) {
    const durations = s.calls.map((c) => c.durationMs);
    const width = Math.min(80, Math.max(20, (stream.columns ?? 100) - 10));
    stream.write("\n  " + style.bold("timeline des durées :") + "\n");
    for (const line of verticalBars(durations.slice(-width), 6)) {
      stream.write("    " + line.replace(/(.)/g, "$1$1") + "\n");
    }
    stream.write("    " + style.gray("spark ") + sparkline(durations, width) + "\n");
  }

  // RPC lentes (initialize / tools/list notamment)
  const slowRpc = [...s.rpc].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
  if (slowRpc.length) {
    stream.write("\n  " + style.bold("JSON-RPC les plus lents :") + "\n");
    for (const r of slowRpc) {
      stream.write(
        `    ${(r.ok ? style.green("ok ") : style.red("ko "))}${r.method.padEnd(28)} ${fmtDuration(r.durationMs)}\n`
      );
    }
  }

  // Erreurs
  if (s.errors.length) {
    stream.write("\n  " + style.boldRed(`erreurs (${s.errors.length}) :`) + "\n");
    // Groupement par message : beaucoup plus lisible qu'une liste à plat.
    const grouped = new Map<string, number>();
    for (const e of s.errors) grouped.set(e.message.slice(0, 160), (grouped.get(e.message.slice(0, 160)) ?? 0) + 1);
    for (const [msg, n] of [...grouped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      stream.write(`    ${style.red(`${n}×`)} ${trunc(msg, (stream.columns ?? 100) - 12)}\n`);
    }
  }

  if (s.stderrLines.length) {
    stream.write("\n  " + style.bold("stderr (5 dernières) :") + "\n");
    for (const l of s.stderrLines.slice(-5)) stream.write("    " + style.dim(trunc(l, (stream.columns ?? 100) - 6)) + "\n");
  }
  stream.write("\n");
}

export function describeLogFile(file: string): string {
  const st = statSync(file);
  return `${basename(file)} (${(st.size / 1024).toFixed(1)}KB, modifié ${st.mtime.toISOString().slice(0, 19).replace("T", " ")})`;
}