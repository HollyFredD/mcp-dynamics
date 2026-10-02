/**
 * Helpers de dates civiles et de trimestres.
 *
 * Bug corrigé ici : `new Date().toISOString().split("T")[0]` renvoie la date
 * **UTC**. En Europe, après 22h (heure d'été) ou 23h (heure d'hiver), le
 * « today » calculé était la VEILLE — ce qui faisait appearing un deal closant
 * aujourd'hui comme « en retard ».
 */
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { QUARTER_RE, QUARTER_CANONICAL_RE } from "./constants.js";

const pad = (n: number) => String(n).padStart(2, "0");

/** Date civile LOCALE au format YYYY-MM-DD (pas d'UTC). */
export function civilDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Date civile locale décalée de `days` jours (négatif pour le passé). */
export function civilDateAddDays(days: number, from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  d.setDate(d.getDate() + days);
  return civilDate(d);
}

/**
 * Analyse une date Dataverse (`2026-09-30T00:00:00Z`, `2026-09-30`) en date
 * civile. Dataverse renvoie les dates en UTC à minuit ; on lit les 10 premiers
 * caractères pour éviter tout décalage de fuseau.
 */
export function civilDateFromDataverse(v: unknown): string | undefined {
  if (typeof v === "string") {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
    if (m) return m[1];
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return civilDate(d);
  }
  return undefined;
}

/**
 * Normalise un trimestre vers le format canonique `YY-Qn`.
 *
 * Accepte : `26-Q2`, `2026-Q2`, `26Q2`, `Q2-26`, `Q2 2026`, `3-2026`…
 * Rejette tout le reste avec un message actionnable — sinon un trimestre mal
 * formaté produisait un filtre valide mais vide, et le modèle concluait
 * « aucun deal dans ce trimestre », ce qui est une erreur de forecast
 * catastrophique.
 */
export function normalizeQuarter(v: unknown, field = "close_quarter"): string {
  const s = String(v ?? "").trim();
  if (!s) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Missing required parameter '${field}'. Use the format '26-Q3' (YY-Qn), e.g. the current quarter.`
    );
  }
  const m = QUARTER_RE.exec(s);
  if (!m) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid ${field}: '${s}'. Expected the format 'YY-Qn' where YY is the 2-digit year and n is 1..4 — for example '26-Q3' or '2026-Q3'.`
    );
  }
  let year: number;
  let q: number;
  if (m[2]) {
    // « 2026-Q3 » ou « 26-Q3 »
    const raw = Number(m[1]);
    year = raw < 100 ? 2000 + raw : raw;
    q = Number(m[2]);
  } else {
    // « Q3-26 » ou « Q3-2026 »
    const raw = Number(m[4]);
    year = raw < 100 ? 2000 + raw : raw;
    q = Number(m[3]);
  }
  if (year < 2000 || year > 2099) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid ${field}: year ${year} in '${s}' is out of range (expected 2000-2099).`
    );
  }
  return `${pad(year % 100)}-Q${q}`;
}

/** Le trimestre civil courant, ex. `26-Q3`. */
export function currentQuarter(d: Date = new Date()): string {
  return `${pad(d.getFullYear() % 100)}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}

function shiftQuarter(quarter: string, delta: number): string {
  const m = QUARTER_CANONICAL_RE.exec(quarter);
  if (!m) return quarter;
  let year = 2000 + Number(m[1]);
  let q = Number(m[2]);
  const total = year * 4 + (q - 1) + delta;
  year = Math.floor(total / 4);
  q = (total % 4) + 1;
  return `${pad(year % 100)}-Q${q}`;
}

export interface QuarterBounds {
  /** 1er jour du trimestre (inclus). */
  start_date: string;
  /** Dernier jour du trimestre (inclus). */
  end_date: string;
}

export function quarterBounds(quarter: string): QuarterBounds {
  const norm = normalizeQuarter(quarter);
  const m = QUARTER_CANONICAL_RE.exec(norm)!;
  const year = 2000 + Number(m[1]);
  const q = Number(m[2]);
  const startMonth = (q - 1) * 3; // 0-based
  const start = new Date(year, startMonth, 1);
  const end = new Date(year, startMonth + 3, 0);
  return { start_date: civilDate(start), end_date: civilDate(end) };
}

export interface QuarterContext extends QuarterBounds {
  quarter: string;
  /** Début du trimestre au format datetime UTC (pour $filter FetchXML/OData). */
  start_datetime: string;
  end_datetime: string;
  is_current: boolean;
  is_past: boolean;
  is_future: boolean;
  days_remaining: number;
  days_elapsed: number;
  total_days: number;
  percent_elapsed: number;
  prev_quarter: string;
  next_quarter: string;
  today: string;
}

/** Contexte complet d'un trimestre : bornes, position dans le temps, voisins. */
export function quarterContext(quarter: string, now: Date = new Date()): QuarterContext {
  const norm = normalizeQuarter(quarter);
  const { start_date, end_date } = quarterBounds(norm);
  const today = civilDate(now);

  const start = new Date(`${start_date}T00:00:00`);
  const end = new Date(`${end_date}T23:59:59.999`);
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msDay = 86_400_000;

  const days_remaining = Math.max(
    0,
    Math.round((end.getTime() - nowMidnight.getTime()) / msDay)
  );
  const days_elapsed = Math.min(
    Math.round((start.getTime() - nowMidnight.getTime()) / msDay) * -1,
    Math.round((end.getTime() - nowMidnight.getTime()) / msDay)
  );
  const total_days = Math.round((end.getTime() - start.getTime()) / msDay) + 1;
  const clampedElapsed = Math.min(Math.max(days_elapsed, 0), total_days);

  return {
    quarter: norm,
    start_date,
    end_date,
    start_datetime: `${start_date}T00:00:00Z`,
    end_datetime: `${end_date}T23:59:59Z`,
    is_current: norm === currentQuarter(now),
    is_past: end.getTime() < nowMidnight.getTime(),
    is_future: start.getTime() > nowMidnight.getTime(),
    days_remaining,
    days_elapsed,
    total_days,
    percent_elapsed: Math.round((clampedElapsed / total_days) * 100),
    prev_quarter: shiftQuarter(norm, -1),
    next_quarter: shiftQuarter(norm, 1),
    today,
  };
}

/** Trimestre déduit d'une date ISO. */
export function quarterOfDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-/.exec(isoDate);
  if (!m) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Cannot derive a quarter from '${isoDate}'. Expected an ISO date YYYY-MM-DD.`
    );
  }
  const q = Math.floor((Number(m[2]) - 1) / 3) + 1;
  return `${pad(Number(m[1]) % 100)}-Q${q}`;
}

/** Normalise un trimestre si présent, sinon undefined. */
export function optionalQuarter(v: unknown, field = "close_quarter"): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return normalizeQuarter(v, field);
}