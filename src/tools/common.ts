/**
 * Helpers partagés par les outils.
 */
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { queryRecords } from "../dataverse.js";
import { odataString } from "../odata.js";
import { normalizeQuarter, optionalQuarter } from "../dates.js";
import {
  CATEGORY_LABELS,
  CLOSE_PROBABILITY_FIELD,
  SN_PROBABILITY_FIELD,
} from "../constants.js";
import { logJson, redact } from "../log.js";

// ---------------------------------------------------------------------------
// Sérialisation
// ---------------------------------------------------------------------------

/**
 * Seuil au-delà duquel on sérialise en compact : `JSON.stringify(x, null, 2)`
 * double le nombre de tokens sur 500 lignes.
 */
const PRETTY_ROW_LIMIT = 60;
const PRETTY_BYTE_LIMIT = 16_000;
/**
 * Plafond DUR de la charge utile texte renvoyée au modèle. Au-delà, le contexte
 * du LLM explose (5 000 lignes × 20 champs ≈ plusieurs Mo) : on renvoie une
 * enveloppe explicite plutôt qu'une réponse silencieusement énorme.
 */
export const MAX_OUTPUT_CHARS = Number(process.env.MCP_DYNAMICS_MAX_OUTPUT ?? 200_000);

/** Propriété `dry_run` commune à tous les outils d'écriture (une seule copie). */
export const DRY_RUN_PROP = {
  dry_run: {
    type: "boolean",
    description:
      "When true (DEFAULT) nothing is written: the tool returns the exact diff it WOULD apply. Set false to actually write.",
  },
} as const;

/** Compte les lignes d'un résultat, quelle que soit la clé utilisée par l'outil. */
export function countRows(result: unknown): number | undefined {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    for (const key of [
      "value",
      "records",
      "opportunities",
      "fields",
      "attributes",
      "results",
      "rows",
      "groups",
      "notes",
      "product_lines",
      "entities",
      "values",
      "specialist_forecasts",
      "calls",
      "at_risk",
    ]) {
      const v = r[key];
      if (Array.isArray(v)) return v.length;
    }
    if (typeof r.row_count === "number") return r.row_count;
    if (typeof r.line_count === "number") return r.line_count;
  }
  return undefined;
}

export function serializeResult(result: unknown): string {
  const rows = countRows(result);
  const pretty = rows === undefined || rows <= PRETTY_ROW_LIMIT;
  // Un seul stringify : l'ancienne version sérialisait deux fois quand le
  // pretty-print dépassait la limite.
  let text = JSON.stringify(result, null, pretty ? 2 : undefined);

  if (text.length > PRETTY_BYTE_LIMIT) {
    const compact = JSON.stringify(result);
    if (compact.length < text.length) text = compact;
  }

  if (text.length <= MAX_OUTPUT_CHARS) return text;

  return JSON.stringify(
    {
      output_truncated: true,
      original_chars: text.length,
      max_chars: MAX_OUTPUT_CHARS,
      hint:
        "The response exceeded the output cap. Re-run with a smaller `top`, a narrower filter, `select` on fewer fields, or use aggregate_query for totals.",
      preview: text.slice(0, Math.max(1_000, MAX_OUTPUT_CHARS - 2_000)),
    },
    null,
    2
  );
}

export function toolResult(result: unknown): {
  content: { type: "text"; text: string }[];
} {
  return { content: [{ type: "text", text: serializeResult(result) }] };
}

// ---------------------------------------------------------------------------
// Décoration commune des lignes
// ---------------------------------------------------------------------------

/**
 * `sn_probability` est un champ CALCULÉ de type chaîne ("100%") : il ne peut
 * être ni filtré ni écrit. On l'expose sous `sn_probability_display` et on
 * ajoute la vraie valeur numérique `close_probability`.
 */
export function probabilityToNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace("%", "").trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Source unique de la décoration probabilité (3 copies avant). */
export function decorateProbability(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  const display = row[SN_PROBABILITY_FIELD];
  if (display !== undefined) {
    out.sn_probability_display = display;
    delete out[SN_PROBABILITY_FIELD];
  }
  out.close_probability =
    (row[CLOSE_PROBABILITY_FIELD] as number) ?? probabilityToNumber(display) ?? null;
  return out;
}

/** Libellé lisible d'un code de catégorie de prévision. */
export function categoryLabel(code: unknown): string | undefined {
  if (typeof code !== "number") return undefined;
  return CATEGORY_LABELS[code] ?? `unknown_${code}`;
}

// ---------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------
export function isMcpError(err: unknown): err is McpError {
  return err instanceof McpError;
}

/** Message court, sans $filter brut ni donnée sensible. */
export function shortError(err: unknown): string {
  if (err instanceof McpError) return redact(err.message);
  if (err instanceof Error) return redact(err.message);
  return redact(String(err));
}

// ---------------------------------------------------------------------------
// Résolutions
// ---------------------------------------------------------------------------
export async function resolveOpportunityId(
  opportunityId?: string,
  opportunityNumber?: string
): Promise<{ id: string; number?: string }> {
  if (opportunityId) {
    return { id: opportunityId, number: opportunityNumber };
  }
  if (!opportunityNumber) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Missing identifier: provide either 'opportunity_id' (a GUID) or 'opportunity_number' (e.g. 'OPTY5331870')."
    );
  }
  const result = await queryRecords({
    entity: "opportunities",
    filter: `sn_number eq ${odataString(opportunityNumber)}`,
    select: ["opportunityid", "sn_number"],
    top: 1,
  });
  const record = result.value[0];
  if (!record) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Opportunity not found: no opportunity has sn_number '${opportunityNumber}'. Verify the number (format OPTY followed by digits) or pass opportunity_id instead.`
    );
  }
  return {
    id: String(record["opportunityid"]).toLowerCase(),
    number: (record["sn_number"] as string) ?? opportunityNumber,
  };
}

/** Normalise un quarter obligatoire. */
export function requireQuarter(v: unknown, field = "close_quarter"): string {
  return normalizeQuarter(v, field);
}

/** Normalise un quarter optionnel. */
export function maybeQuarter(v: unknown, field = "close_quarter"): string | undefined {
  return optionalQuarter(v, field);
}

// ---------------------------------------------------------------------------
// Diff / dry-run (T2)
// ---------------------------------------------------------------------------
export interface FieldDiff {
  field: string;
  from: unknown;
  to: unknown;
  /** true si la valeur lue diffère de celle demandée (échec d'écriture probable). */
  mismatch?: boolean;
}

function comparable(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return String(v);
}

/** Construit le diff exact {field, from, to} à partir d'une lecture préalable. */
export function buildDiff(
  before: Record<string, unknown>,
  data: Record<string, unknown>
): FieldDiff[] {
  const diff: FieldDiff[] = [];
  for (const [field, to] of Object.entries(data)) {
    const from = before[field];
    diff.push({ field, from: from ?? null, to });
  }
  return diff;
}

/** Compare les valeurs relues après écriture avec les valeurs demandées. */
export function verifyWrite(
  reread: Record<string, unknown>,
  data: Record<string, unknown>
): { verified: boolean; mismatches: FieldDiff[] } {
  const mismatches: FieldDiff[] = [];
  for (const [field, to] of Object.entries(data)) {
    if (field.includes("@odata.bind") || field.endsWith("_base")) continue;
    const actual = reread[field];
    // Dataverse OMET les champs nuls de la réponse : écrire `null` produisait
    // un faux mismatch. Un null attendu est vérifié comme null/absent.
    const expectedNull = to === null || to === undefined;
    const same = expectedNull
      ? actual === null || actual === undefined || actual === ""
      : comparable(actual) === comparable(to) ||
        (typeof to === "number" && typeof actual === "number" && Math.abs(actual - to) < 1e-6);
    if (!same) mismatches.push({ field, from: actual ?? null, to, mismatch: true });
  }
  return { verified: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// Journalisation des mutations (P2.4 / C4)
// ---------------------------------------------------------------------------
export function logMutation(action: string, details: Record<string, unknown>): void {
  logJson({ event: "mutation", action, ...details });
}