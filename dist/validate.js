/**
 * Validation des arguments d'outils.
 *
 * Le SDK MCP bas niveau n'applique PAS les `enum` des inputSchema : sans cette
 * couche, `role: "bogus"` produisait `undefined eq 'guid'` (HTTP 400) et
 * `stale_days: "30"` (chaîne) provoquait un `RangeError: Invalid time value`
 * qui faisait échouer tout l'outil.
 *
 * Règle : toute erreur de validation lève une McpError(InvalidParams) avec un
 * message ACTIONNABLE qui énumère les valeurs autorisées, pour que le modèle
 * puisse se corriger sans aller-retour.
 */
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { FORBIDDEN_ENTITY_SUBSTRINGS } from "./constants.js";
import { assertEntityName, guid as validateGuid } from "./odata.js";
function fail(message) {
    throw new McpError(ErrorCode.InvalidParams, message);
}
export function quoteList(values) {
    return values.map((v) => `'${v}'`).join(", ");
}
/** Valide une valeur contre une liste blanche. `def` si la valeur est absente. */
export function oneOf(v, allowed, field, def) {
    if (v === undefined || v === null || v === "") {
        if (def !== undefined)
            return def;
        return undefined;
    }
    if (typeof v !== "string") {
        fail(`Invalid '${field}': expected one of ${quoteList(allowed)}, received ${JSON.stringify(v)} (${typeof v}).`);
    }
    const s = v.trim();
    // Tolérance casse (les LLM écrivent parfois "Best_Case").
    const hit = allowed.find((a) => a.toLowerCase() === s.toLowerCase());
    if (!hit) {
        fail(`Invalid '${field}': '${s}'. Allowed values: ${quoteList(allowed)}.`);
    }
    return hit;
}
/** Valide un entier. Accepte un nombre OU une chaîne numérique ("30"). */
export function intIn(v, field, opts = {}) {
    if (v === undefined || v === null || v === "") {
        return opts.def;
    }
    let n;
    if (typeof v === "number") {
        n = v;
    }
    else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.trim()))) {
        n = Number(v.trim());
    }
    else {
        return fail(`Invalid '${field}': expected ${opts.def !== undefined ? `an integer (default ${opts.def})` : "an integer"}, received ${JSON.stringify(v)} (${typeof v}). Pass a number such as ${opts.def ?? 10}.`);
    }
    if (!Number.isFinite(n)) {
        return fail(`Invalid '${field}': '${String(v)}' is not a finite number.`);
    }
    n = Math.trunc(n);
    if (opts.min !== undefined && n < opts.min) {
        return fail(`Invalid '${field}': ${n} is below the minimum of ${opts.min}. Use a value >= ${opts.min}.`);
    }
    if (opts.max !== undefined && n > opts.max) {
        return fail(`Invalid '${field}': ${n} is above the maximum of ${opts.max}. Use a value <= ${opts.max}.`);
    }
    if (opts.maxExclusive !== undefined && n >= opts.maxExclusive) {
        return fail(`Invalid '${field}': ${n} must be strictly less than ${opts.maxExclusive}. Use a value <= ${opts.maxExclusive - 1}.`);
    }
    return n;
}
/** Valide un booléen, en tolérant "true"/"false"/1/0. */
export function bool(v, field, def) {
    if (v === undefined || v === null || v === "")
        return def;
    if (typeof v === "boolean")
        return v;
    if (typeof v === "number" && (v === 0 || v === 1))
        return v === 1;
    if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (["true", "1", "yes", "y", "on"].includes(s))
            return true;
        if (["false", "0", "no", "n", "off"].includes(s))
            return false;
    }
    return fail(`Invalid '${field}': expected true or false, received ${JSON.stringify(v)} (${typeof v}).`);
}
/** Valide une chaîne optionnelle. */
export function str(v, field, opts = {}) {
    if (v === undefined || v === null)
        return undefined;
    if (typeof v !== "string") {
        return fail(`Invalid '${field}': expected a string, received ${JSON.stringify(v)} (${typeof v}).`);
    }
    const s = opts.trim === false ? v : v.trim();
    if (!s)
        return undefined;
    if (opts.max !== undefined && s.length > opts.max) {
        return fail(`'${field}' is too long: ${s.length} characters, maximum is ${opts.max}. Shorten it.`);
    }
    if (opts.min !== undefined && s.length < opts.min) {
        return fail(`'${field}' is too short: ${s.length} characters, minimum is ${opts.min}.`);
    }
    return s;
}
/** Valide une chaîne obligatoire et non vide. */
export function requiredStr(v, field, opts = {}) {
    const s = str(v, field, opts);
    if (!s) {
        return fail(`Missing required parameter '${field}': a non-empty string is required${opts.max ? ` (max ${opts.max} characters)` : ""}.`);
    }
    return s;
}
/** Valide un tableau de chaînes. */
export function strArray(v, field, opts = {}) {
    if (v === undefined || v === null || v === "")
        return undefined;
    let arr;
    if (Array.isArray(v)) {
        arr = v;
    }
    else if (typeof v === "string") {
        arr = v.split(",").map((s) => s.trim()).filter(Boolean);
    }
    else {
        return fail(`Invalid '${field}': expected an array of strings, received ${typeof v}. Pass e.g. ${JSON.stringify(["Security", "Risk"])}.`);
    }
    if (opts.maxItems !== undefined && arr.length > opts.maxItems) {
        return fail(`'${field}' has too many items: ${arr.length}, maximum is ${opts.maxItems}.`);
    }
    const out = [];
    for (const item of arr) {
        if (typeof item !== "string") {
            return fail(`Invalid '${field}': every item must be a string, found ${JSON.stringify(item)}.`);
        }
        const s = opts.trim === false ? item : item.trim();
        if (!s)
            continue;
        if (opts.max !== undefined && s.length > opts.max) {
            return fail(`An item of '${field}' is too long (${s.length} > ${opts.max} chars): '${s.slice(0, 40)}…'`);
        }
        out.push(s);
    }
    return out.length ? out : undefined;
}
/** Valide un objet (payload `data` des outils d'écriture). */
export function record(v, field = "data") {
    if (v === undefined || v === null) {
        return fail(`Missing required parameter '${field}': an object mapping Dataverse field names to values, e.g. {"name":"ACME","estimatedvalue":1000}.`);
    }
    if (typeof v !== "object" || Array.isArray(v)) {
        return fail(`Invalid '${field}': expected an object of field/value pairs, received ${Array.isArray(v) ? "an array" : typeof v}.`);
    }
    const obj = v;
    const keys = Object.keys(obj);
    if (!keys.length) {
        return fail(`'${field}' is empty: provide at least one field, e.g. {"name":"…"}.`);
    }
    for (const k of keys) {
        const val = obj[k];
        if (val === undefined || typeof val === "function" || typeof val === "symbol") {
            return fail(`Invalid '${field}.${k}': value must be a string, number, boolean, null or a nested object, received ${typeof val}.`);
        }
    }
    return obj;
}
/** Valide un GUID Dataverse (délègue à odata.ts). */
export function guidParam(v, field = "id") {
    return validateGuid(String(v ?? ""), field);
}
/** Valide un nom d'entité (anti-traversée). */
export function entityName(v, field = "entity") {
    const s = assertEntityName(v, field);
    const low = s.toLowerCase();
    for (const bad of FORBIDDEN_ENTITY_SUBSTRINGS) {
        if (low.includes(bad)) {
            return fail(`Invalid '${field}': '${s}' contains the forbidden sequence '${bad}'.`);
        }
    }
    return s;
}
/** Normalise un tableau d'entités et renvoie la liste canonique. */
export function entityNameList(v, field = "entity") {
    const arr = strArray(v, field, { max: 128, maxItems: 50 });
    return (arr ?? []).map((e) => entityName(e, field));
}
/** Valide un format de date YYYY-MM-DD (renvoie la valeur normalisée). */
export function isoDate(v, field) {
    const s = requiredStr(v, field, { max: 40 });
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) {
        return fail(`Invalid '${field}': '${s}' is not an ISO date. Use the format YYYY-MM-DD, e.g. 2026-09-30.`);
    }
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) {
        return fail(`Invalid '${field}': '${s}' is not a real calendar date. Use YYYY-MM-DD.`);
    }
    return `${m[1]}-${m[2]}-${m[3]}`;
}
/** Valide un montant (ACV) : nombre fini, optionnellement > 0. */
export function amount(v, field) {
    const n = intIn(v, field, { def: undefined });
    if (n === undefined) {
        return fail(`Missing required parameter '${field}': expected a number (e.g. 25000).`);
    }
    return n;
}
//# sourceMappingURL=validate.js.map