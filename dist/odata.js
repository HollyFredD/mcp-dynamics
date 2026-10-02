import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
// ---------------------------------------------------------------------------
// Échappement OData / FetchXML
// ---------------------------------------------------------------------------
/**
 * Encode une valeur pour un littéral de chaîne OData V4.
 *
 * OData V4 n'utilise PAS de séquence d'échappement : la seule façon de
 * représenter une apostrophe est de la doubler (RFC 2110, §"Literals").
 * Sans cela `name eq 'L'Oréal'` produit un 400.
 *
 * On supprime aussi les caractères de contrôle (invisibles, interdits par la
 * grammaire de chaînes OData) pour éviter toute ambiguïté.
 */
export function odataString(v) {
    const raw = v == null ? "" : String(v);
    const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    return `'${cleaned.replace(/'/g, "''")}'`;
}
/** Encode une valeur pour un attribut XML (guillemets doubles ou simples). */
export function xmlAttr(v) {
    return String(v == null ? "" : v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
/** Échappe le contenu textuel d'un élément XML. */
export function xmlText(v) {
    return String(v == null ? "" : v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/**
 * Valide un GUID Dataverse. Un GUID invalide produirait une requête vers
 * `/opportunities(xyz)` qui renvoie une 404 obscure ; mieux vaut une erreur
 * actionnable.
 */
export function guid(v, field = "id") {
    const s = String(v ?? "").trim();
    if (!s) {
        throw new McpError(ErrorCode.InvalidParams, `Missing required parameter '${field}': expected a GUID like '00000000-0000-0000-0000-000000000000'.`);
    }
    const bare = s.replace(/[{}]/g, "");
    if (!GUID_RE.test(bare)) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid ${field}: '${s}' is not a Dataverse GUID. Expected 36 characters in the format 00000000-0000-0000-0000-000000000000. If you have an opportunity number (OPTY1234567) use opportunity_number instead.`);
    }
    return bare.toLowerCase();
}
/** Encode un entier pour un filtre OData / FetchXML (aucune injection possible). */
export function odataInt(v, field = "value") {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid ${field}: expected a number, received ${JSON.stringify(v)}.`);
    }
    return String(Math.trunc(n));
}
/**
 * Encode une valeur pour un littéral FetchXML (attribut `value="…"`).
 * On combine xmlAttr + suppression des guillemets qui casseraient l'élément
 * `<condition …>`.
 */
export function fetchxmlValue(v) {
    return xmlAttr(String(v)).replace(/"/g, "&quot;");
}
/**
 * Valide un nom d'entité : interdit la traversée de chemin (`../../WhoAmI`),
 * les métadonnées globales et les caractères d'URL.
 */
export function assertEntityName(v, field = "entity") {
    const s = String(v ?? "").trim();
    if (!s) {
        throw new McpError(ErrorCode.InvalidParams, `Missing required parameter '${field}': the logical name of a Dataverse entity, e.g. 'opportunities'.`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid ${field}: '${s}'. A logical name must match /^[A-Za-z_][A-Za-z0-9_]*$/ (letters, digits, underscore). Use query_records with $expand to reach related entities instead of a path.`);
    }
    return s;
}
/**
 * Aplatit un `LocalizedLabels` Dataverse en une chaîne.
 *
 * Dataverse sérialise les labels ainsi :
 *   DisplayCollectionName: { LocalizedLabels: [ { Label: "…", LanguageCode: 1033 } ] }
 * La propriété `UserLocalizedLabel` n'existe PAS dans les réponses de
 * l'API WebDAV/OData de Dataverse — c'était la cause du bug qui affichait le
 * LogicalName comme displayName.
 *
 * On préfère le label 1033 (anglais), sinon le premier disponible.
 */
export function labelOf(value) {
    if (value == null)
        return undefined;
    if (typeof value === "string")
        return value || undefined;
    if (typeof value !== "object")
        return undefined;
    const coll = value;
    // Cas plat : { Label: "…", LanguageCode: 1033 }
    if (typeof coll.Label === "string")
        return coll.Label || undefined;
    // Cas Dataverse : { LocalizedLabels: [...] }
    const labels = coll.LocalizedLabels;
    if (Array.isArray(labels)) {
        const en = labels.find((l) => l?.LanguageCode === 1033 && l?.Label);
        const first = labels.find((l) => l?.Label);
        return (en ?? first)?.Label || undefined;
    }
    // Repli : Old UserLocalizedLabel (certainesounités renvoient encore ça).
    if (coll.UserLocalizedLabel?.Label)
        return coll.UserLocalizedLabel.Label;
    return undefined;
}
//# sourceMappingURL=odata.js.map