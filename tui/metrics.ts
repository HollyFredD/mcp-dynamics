import type { CallRecord } from "./types.ts";

/** Bornes de la fenêtre glissante de la timeline. */
export const TIMELINE_WINDOW = 50;
/** Nombre maximum d'erreurs conservées en mémoire. */
const MAX_ERRORS = 20;

export interface Stats {
  count: number;
  errors: number;
  /** taux d'erreur en % (0 si aucun appel) */
  errorRate: number;
  avg: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  /** somme des durées, utile pour détecter la dérive de perf dans le temps */
  totalMs: number;
  tokens: number;
  bytes: number;
}

export interface ToolStat extends Stats {
  tool: string;
  /** nombre d'appels en cours (non résolus) */
  inflight: number;
}

/** Percentile par interpolation linéaire (méthode "nearest-rank" lissée). */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

export function computeStats(durations: number[], tokens = 0, bytes = 0): Stats {
  if (durations.length === 0) {
    return {
      count: 0, errors: 0, errorRate: 0, avg: 0, p50: 0, p95: 0,
      min: 0, max: 0, totalMs: 0, tokens, bytes,
    };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const total = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    errors: 0, // renseigné par Metrics (les durées ne portent pas l'info)
    errorRate: 0,
    avg: total / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    totalMs: total,
    tokens,
    bytes,
  };
}

/**
 * Collecteur de métriques en mémoire : alimente le dashboard temps réel et le
 * mode bench. Volontairement sans dépendances (pas d'ui-state-manager).
 */
export class Metrics {
  private records: CallRecord[] = [];
  private inflightCount = 0;
  readonly startedAt = Date.now();
  /** erreurs récentes (les 20 dernières) */
  readonly recentErrors: Array<CallRecord & { message: string }> = [];

  record(rec: CallRecord): void {
    this.records.push(rec);
    // On borne la mémoire : 5000 appels suffisent largement à l'analyse de perf
    // et évitent de faire grossir un process laissé ouvert des heures.
    if (this.records.length > 5000) this.records.splice(0, this.records.length - 5000);
    if (!rec.ok && rec.error) {
      this.recentErrors.push({ ...rec, message: rec.error });
      if (this.recentErrors.length > MAX_ERRORS) this.recentErrors.shift();
    }
  }

  inflightStart(): void {
    this.inflightCount++;
  }

  inflightEnd(): void {
    this.inflightCount = Math.max(0, this.inflightCount - 1);
  }

  get all(): CallRecord[] {
    return this.records;
  }

  get total(): number {
    return this.records.length;
  }

  get inFlight(): number {
    return this.inflightCount;
  }

  get errorCount(): number {
    return this.records.reduce((n, r) => n + (r.ok ? 0 : 1), 0);
  }

  /** Derniers appels (fenêtre glissante) pour la timeline ASCII. */
  timeline(window = TIMELINE_WINDOW): CallRecord[] {
    return this.records.slice(-window);
  }

  stats(window = Number.POSITIVE_INFINITY): Stats {
    const slice = window === Number.POSITIVE_INFINITY
      ? this.records
      : this.records.slice(-window);
    const s = computeStats(
      slice.map((r) => r.durationMs),
      slice.reduce((n, r) => n + r.tokens, 0),
      slice.reduce((n, r) => n + r.argsBytes + r.resultBytes, 0)
    );
    s.errors = slice.reduce((n, r) => n + (r.ok ? 0 : 1), 0);
    s.errorRate = s.count === 0 ? 0 : (s.errors / s.count) * 100;
    return s;
  }

  /** Répartition par outil, triée par nombre d'appels décroissant. */
  byTool(limit = 8): ToolStat[] {
    const map = new Map<string, CallRecord[]>();
    for (const r of this.records) {
      const list = map.get(r.tool);
      if (list) list.push(r);
      else map.set(r.tool, [r]);
    }
    return [...map.entries()]
      .map(([tool, list]) => {
        const s = computeStats(
          list.map((r) => r.durationMs),
          list.reduce((n, r) => n + r.tokens, 0),
          list.reduce((n, r) => n + r.argsBytes + r.resultBytes, 0)
        );
        s.errors = list.reduce((n, r) => n + (r.ok ? 0 : 1), 0);
        s.errorRate = s.count === 0 ? 0 : (s.errors / s.count) * 100;
        return { ...s, tool, inflight: 0 };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /** Histogramme des durées, `buckets` tranches entre min et max. */
  histogram(buckets = 12): Array<{ from: number; to: number; count: number }> {
    const durations = this.records.map((r) => r.durationMs);
    if (durations.length === 0) return [];
    const min = Math.min(...durations);
    const max = Math.max(...durations);
    const span = max - min || 1;
    const out = Array.from({ length: buckets }, (_, i) => ({
      from: min + (span * i) / buckets,
      to: min + (span * (i + 1)) / buckets,
      count: 0,
    }));
    for (const d of durations) {
      let idx = Math.floor(((d - min) / span) * buckets);
      if (idx >= buckets) idx = buckets - 1;
      if (idx < 0) idx = 0;
      out[idx].count++;
    }
    return out;
  }

  uptimeMs(now = Date.now()): number {
    return now - this.startedAt;
  }
}

/** Met en forme une durée ms de façon compacte : `842ms`, `1.24s`, `3m07s`. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

export function fmtUptime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m${String(s).padStart(2, "0")}s`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

export function fmtNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}