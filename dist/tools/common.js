/**
 * Helpers partagés par les outils.
 */
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { queryRecords } from "../dataverse.js";
import { odataString } from "../odata.js";
import { normalizeQuarter, optionalQuarter } from "../dates.js";
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
function countRows(result) {
    if (result && typeof result === "object") {
        const r = result;
        if (Array.isArray(r.value))
            return r.value.length;
        if (Array.isArray(r.records))
            return r.records.length;
        if (Array.isArray(r.opportunities))
            return r.opportunities.length;
        if (Array.isArray(r.fields))
            return r.fields.length;
        if (Array.isArray(r.attributes))
            return r.attributes.length;
        if (Array.isArray(r.results))
            return r.results.length;
        if (Array.isArray(r.rows))
            return r.rows.length;
        if (Array.isArray(r.groups))
            return r.groups.length;
    }
    return undefined;
}
export function serializeResult(result) {
    const rows = countRows(result);
    const pretty = (rows === undefined || rows <= PRETTY_ROW_LIMIT);
    const text = JSON.stringify(result, null, pretty ? 2 : undefined);
    return pretty && text.length <= PRETTY_BYTE_LIMIT
        ? text
        : JSON.stringify(result);
}
export function toolResult(result) {
    return { content: [{ type: "text", text: serializeResult(result) }] };
}
// ---------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------
export function isMcpError(err) {
    return err instanceof McpError;
}
/** Message court, sans $filter brut ni donnée sensible. */
export function shortError(err) {
    if (err instanceof McpError)
        return redact(err.message);
    if (err instanceof Error)
        return redact(err.message);
    return redact(String(err));
}
// ---------------------------------------------------------------------------
// Résolutions
// ---------------------------------------------------------------------------
export async function resolveOpportunityId(opportunityId, opportunityNumber) {
    if (opportunityId) {
        return { id: opportunityId, number: opportunityNumber };
    }
    if (!opportunityNumber) {
        throw new McpError(ErrorCode.InvalidParams, "Missing identifier: provide either 'opportunity_id' (a GUID) or 'opportunity_number' (e.g. 'OPTY5331870').");
    }
    const result = await queryRecords({
        entity: "opportunities",
        filter: `sn_number eq ${odataString(opportunityNumber)}`,
        select: ["opportunityid", "sn_number"],
        top: 1,
    });
    const record = result.value[0];
    if (!record) {
        throw new McpError(ErrorCode.InvalidParams, `Opportunity not found: no opportunity has sn_number '${opportunityNumber}'. Verify the number (format OPTY followed by digits) or pass opportunity_id instead.`);
    }
    return {
        id: String(record["opportunityid"]).toLowerCase(),
        number: record["sn_number"] ?? opportunityNumber,
    };
}
/** Normalise un quarter obligatoire. */
export function requireQuarter(v, field = "close_quarter") {
    return normalizeQuarter(v, field);
}
/** Normalise un quarter optionnel. */
export function maybeQuarter(v, field = "close_quarter") {
    return optionalQuarter(v, field);
}
function comparable(v) {
    if (v === null || v === undefined)
        return "";
    if (typeof v === "number" || typeof v === "boolean")
        return String(v);
    return String(v);
}
/** Construit le diff exact {field, from, to} à partir d'une lecture préalable. */
export function buildDiff(before, data) {
    const diff = [];
    for (const [field, to] of Object.entries(data)) {
        const from = before[field];
        diff.push({ field, from: from ?? null, to });
    }
    return diff;
}
/** Compare les valeurs relues après écriture avec les valeurs demandées. */
export function verifyWrite(reread, data) {
    const mismatches = [];
    for (const [field, to] of Object.entries(data)) {
        if (field.includes("@odata.bind") || field.endsWith("_base"))
            continue;
        if (!(field in reread)) {
            mismatches.push({ field, from: null, to, mismatch: true });
            continue;
        }
        const actual = reread[field];
        const same = comparable(actual) === comparable(to) ||
            (typeof to === "number" && typeof actual === "number" && Math.abs(actual - to) < 1e-6);
        if (!same)
            mismatches.push({ field, from: actual ?? null, to, mismatch: true });
    }
    return { verified: mismatches.length === 0, mismatches };
}
// ---------------------------------------------------------------------------
// Journalisation des mutations (P2.4 / C4)
// ---------------------------------------------------------------------------
export function logMutation(action, details) {
    logJson({ event: "mutation", action, ...details });
}
//# sourceMappingURL=common.js.map