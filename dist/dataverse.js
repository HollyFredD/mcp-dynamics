import { AzureCliCredential } from "@azure/identity";
import axios from "axios";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { MAX_RETRIES, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS, READ_TIMEOUT_MS, WRITE_TIMEOUT_MS, TOKEN_EXPIRY_MARGIN_MS, HARD_PAGE_CAP, DEFAULT_MAX_PAGES, MAX_PAGE_SIZE, DEFAULT_QUERY_ROWS, WRITE_ALLOWLIST, DELETE_DENYLIST, CURRENCY_GUIDS, PRIMARY_UNIT_ID, } from "./constants.js";
import { odataString, guid as validateGuid, labelOf, assertEntityName } from "./odata.js";
import { cacheWrap, cacheGet, cacheSet } from "./cache.js";
import { bumpDataverseCall, logJson, redact } from "./log.js";
// ---------------------------------------------------------------------------
// Configuration (M3 : configurable par env)
// ---------------------------------------------------------------------------
export const INSTANCE_URL = (process.env.DYNAMICS_INSTANCE_URL ?? "https://servicenow.crm.dynamics.com").replace(/\/+$/, "");
export const API_VERSION = process.env.DYNAMICS_API_VERSION ?? "v9.2";
const BASE_URL = `${INSTANCE_URL}/api/data/${API_VERSION}`;
const SCOPE = `${INSTANCE_URL}/.default`;
/**
 * Mode lecture seule (T4).
 *
 * En transport HTTP, le read-only est activé PAR DÉFAUT : ce port est une
 * surface d'attaque réseau et le serveur agit avec l'identité unique du compte
 * qui a lancé `az login`. `MCP_DYNAMICS_READONLY=0` est le seul moyen explicite
 * de le désactiver — un simple `MCP_DYNAMICS_READONLY=foo` ne suffit pas à
 * ouvrir les écritures par erreur de frappe.
 *
 * ⚠️ Ce calcul est la SOURCE DE VRAIE : `src/http.ts` lit cette valeur, il ne
 * la redéfinit pas. Une variable d'affichage qui diverge de la garde effective
 * est pire que pas de variable du tout.
 */
const READONLY_ENV = process.env.MCP_DYNAMICS_READONLY;
export const READONLY = READONLY_ENV === "1" ||
    (READONLY_ENV !== "0" && process.env.MCP_DYNAMICS_TRANSPORT === "http");
/** Liste blanche d'entités (T4). Vide = pas de restriction. */
export const ALLOWED_ENTITIES = (process.env.MCP_DYNAMICS_ALLOWED_ENTITIES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
const credential = new AzureCliCredential();
let tokenCache = null;
let tokenInFlight = null;
async function getToken() {
    const now = Date.now();
    if (tokenCache && tokenCache.validUntil > now)
        return tokenCache.token;
    // Déduplication : plusieurs appels concurrents ne déclenchent qu'un `az` hit.
    if (!tokenInFlight) {
        tokenInFlight = (async () => {
            try {
                const token = await credential.getToken(SCOPE);
                if (!token?.token) {
                    throw new McpError(ErrorCode.InternalError, "Azure authentication failed: no token returned. Run `az login` and make sure the signed-in account has access to the Dynamics instance, then retry.");
                }
                // AzureCliCredential exposes expiresOnTimestamp (epoch seconds).
                const expiresAtMs = token.expiresOnTimestamp
                    ? token.expiresOnTimestamp * 1000
                    : now + 50 * 60_000;
                tokenCache = {
                    token: token.token,
                    validUntil: Math.min(expiresAtMs, now + 50 * 60_000) - TOKEN_EXPIRY_MARGIN_MS,
                };
                return tokenCache.token;
            }
            catch (err) {
                // AzureCliCredential échoue avec une erreur opaque (« az: not found »,
                // « Please run az login ») : on la traduit en message actionnable.
                throw new McpError(ErrorCode.InternalError, `Azure authentication failed: ${redact(err instanceof Error ? err.message : String(err))}. ` +
                    `Hint: run 'az login' in the shell that launched the server and make sure the Azure CLI is installed and on PATH. ` +
                    `Then verify with 'az account show'.`);
            }
            finally {
                tokenInFlight = null;
            }
        })();
    }
    return tokenInFlight;
}
/** Invalide le cache de token (appelée sur un 401). */
export function invalidateToken() {
    tokenCache = null;
}
let cached = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function retryDelay(attempt, retryAfter) {
    // Retry-After peut être en secondes (entier) ou une date HTTP.
    if (retryAfter) {
        const secs = Number(retryAfter);
        if (Number.isFinite(secs) && secs >= 0) {
            return Math.min(secs * 1000, RETRY_MAX_DELAY_MS);
        }
        const asDate = Date.parse(retryAfter);
        if (!Number.isNaN(asDate)) {
            return Math.min(Math.max(asDate - Date.now(), 0), RETRY_MAX_DELAY_MS);
        }
    }
    // Exponentiel + jitter full pour éviter le thundering herd sur le throttling.
    const base = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
    return Math.round(base * (0.5 + Math.random() * 0.5));
}
function buildClient(token) {
    const api = axios.create({
        baseURL: BASE_URL,
        timeout: READ_TIMEOUT_MS,
        headers: {
            Authorization: `Bearer ${token}`,
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
            Accept: "application/json;odata.metadata=minimal",
            "Content-Type": "application/json",
        },
        // ⚠️ H15 : `Prefer: odata.include-annotations=*` est retiré du header par
        // défaut. Il triplait la taille des payloads envoyés au LLM. Il peut être
        // reactivé par requête via `include_annotations`.
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 300,
    });
    api.interceptors.response.use((res) => res, async (error) => {
        if (!axios.isAxiosError(error) || !error.config)
            throw error;
        const cfg = error.config;
        const status = error.response?.status;
        const retryable = status === 429 || (status !== undefined && status >= 500);
        if (retryable && (cfg.__retries ?? 0) < MAX_RETRIES) {
            cfg.__retries = (cfg.__retries ?? 0) + 1;
            const retryAfter = String(error.response?.headers?.["retry-after"] ?? "");
            const delay = retryDelay(cfg.__retries - 1, retryAfter);
            logJson({
                event: "dataverse_retry",
                status,
                attempt: cfg.__retries,
                delay_ms: delay,
                method: cfg.method?.toUpperCase(),
            });
            await sleep(delay);
            bumpDataverseCall();
            return api.request(cfg);
        }
        // H3 : sur 401, on invalide le token et on rejoue UNE seule fois.
        if (status === 401 && !cfg.__reauth) {
            cfg.__reauth = true;
            invalidateToken();
            cached = null;
            try {
                const fresh = await getToken();
                cfg.headers.set("Authorization", `Bearer ${fresh}`);
                bumpDataverseCall();
                return api.request(cfg);
            }
            catch (authErr) {
                throw authErr;
            }
        }
        throw error;
    });
    return api;
}
/** Retourne le client mis en cache (avec token valide), le recréant au besoin. */
export async function getClient() {
    if (cached) {
        // Token encore valide pendant la marge de sécurité ?
        try {
            const current = await getToken();
            if (current === cached.token)
                return cached.client;
        }
        catch {
            /* on recrée en dessous */
        }
    }
    const token = await getToken();
    cached = { client: buildClient(token), token };
    return cached.client;
}
/** Invalide le client + le token (tests, changement d'instance). */
export function resetClient() {
    cached = null;
    tokenCache = null;
}
// ---------------------------------------------------------------------------
// Couche HTTP unifiée
// ---------------------------------------------------------------------------
async function send(method, url, config = {}, isWrite = false) {
    const api = await getClient();
    bumpDataverseCall();
    try {
        const res = await api.request({
            method,
            url,
            timeout: isWrite ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS,
            ...config,
        });
        return res.data;
    }
    catch (err) {
        throw formatDataverseError(err, url);
    }
}
// ---------------------------------------------------------------------------
// Erreurs (H14)
// ---------------------------------------------------------------------------
/**
 * Dataverse renvoie dans `error.message` le $filter complet — donc des emails,
 * des noms de comptes et des numéros d'opportunité en clair. On ne le relaie
 * jamais tel quel : on extrait un message court et on ajoute un hint
 * actionnable.
 */
export function scrubServerMessage(msg) {
    let m = String(msg);
    // Dataverse recopie le $filter / le FetchXml COMPLET dans son message : ce
    // texte contient des emails, des noms de comptes et des numéros d'opportunité.
    // On le supprime intégralement, pas seulement ses littéraux.
    m = m.replace(/\$filter\s*=\s*[^\n]*/gi, "$filter=<redacted>");
    m = m.replace(/fetchXml\s*=\s*[^\n]*/gi, "fetchXml=<redacted>");
    // Reste des littéraux de chaîne (noms de comptes, emails) ailleurs.
    m = m.replace(/'[^']*'/g, "'<value>'");
    m = m.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");
    m = m.replace(/OPTY\d+/g, "<opportunity>");
    m = m.replace(/\s+/g, " ").trim();
    m = m.replace(/\.\s*(?:Hint:)?\s*$/, "");
    return m.length > 200 ? `${m.slice(0, 197)}…` : m;
}
function statusHint(status, write) {
    switch (status) {
        case 400:
            return "Bad request: the OData filter, FetchXML or a field name is invalid. Call describe_entity_fields / list_picklist_values to verify the schema, and check that you are not writing a calculated or read-only field.";
        case 401:
            return "Not authenticated: the Azure token is missing or expired. Run `az login`, then verify you are signed in to an account with access to this Dataverse environment.";
        case 403:
            return "Access denied: the signed-in user lacks security roles or table permissions for this entity/operation. Ask the Dataverse administrator to grant the role, or use another entity.";
        case 404:
            return "Not found: the entity logical name, the record GUID, or the requested metadata does not exist in this environment. Verify with describe_entity_fields.";
        case 409:
            return "Conflict: the record was modified concurrently or duplicates an existing record. Re-read the record with get_record and retry.";
        case 429:
            return "Throttled by Dataverse. Wait before retrying; reduce the volume of records requested (lower `top`) and avoid full-entity scans.";
        case 500:
        case 502:
        case 503:
        case 504:
            return "Dataverse server error or unavailable. Retry in a few seconds; if it persists, the environment is degraded.";
        default:
            return write
                ? "The write operation failed. Re-read the record to check whether it was applied."
                : "The read operation failed. Re-check the arguments.";
    }
}
/** Convertit une erreur axios en McpError enrichie (statut HTTP + hint). */
export function formatDataverseError(err, url = "") {
    if (err instanceof McpError)
        return err;
    if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const raw = err.response?.data?.error?.message ??
            err.message ??
            "unknown error";
        const short = scrubServerMessage(String(raw));
        const code = err.code === "ECONNABORTED" ? " (timeout)" : "";
        return new McpError(ErrorCode.InternalError, `Dataverse HTTP ${status ?? "network"}${code} — ${short}. Hint: ${statusHint(status, false)} [path: ${url.split("?")[0]}]`);
    }
    return new McpError(ErrorCode.InternalError, `Unexpected error: ${redact(err instanceof Error ? err.message : String(err))}`);
}
// ---------------------------------------------------------------------------
// Garde-fous d'écriture (C4, T4)
// ---------------------------------------------------------------------------
export function assertWritable(entity, operation) {
    if (READONLY) {
        throw new McpError(ErrorCode.InvalidParams, `Server is running in READ-ONLY mode (MCP_DYNAMICS_READONLY=1): '${operation}' on '${entity}' is refused. Restart the server without MCP_DYNAMICS_READONLY to allow writes.`);
    }
    if (ALLOWED_ENTITIES.length && !ALLOWED_ENTITIES.includes(entity.toLowerCase())) {
        throw new McpError(ErrorCode.InvalidParams, `Entity '${entity}' is not in MCP_DYNAMICS_ALLOWED_ENTITIES (${ALLOWED_ENTITIES.join(", ")}). Allowed: ${ALLOWED_ENTITIES.join(", ")}.`);
    }
}
export function assertEntityWritable(entity, sanctioned) {
    assertWritable(entity, "write");
    const allowed = sanctioned ?? WRITE_ALLOWLIST;
    if (!allowed.includes(entity)) {
        throw new McpError(ErrorCode.InvalidParams, `Writing to '${entity}' is not allowed. The write allow-list is: ${allowed.join(", ")}. Use a purpose-built tool (update_opportunity_forecast, update_specialist_forecast, add_opportunity_product, add_collaboration_note) instead of a generic write on system entities.`);
    }
}
export function assertEntityDeletable(entity) {
    assertWritable(entity, "delete");
    if (DELETE_DENYLIST.includes(entity)) {
        throw new McpError(ErrorCode.InvalidParams, `Deleting '${entity}' is permanently forbidden: it holds Dataverse configuration, security or permissions. Close or deactivate the record instead.`);
    }
    if (!WRITE_ALLOWLIST.includes(entity)) {
        throw new McpError(ErrorCode.InvalidParams, `Deleting from '${entity}' is not allowed. Deletable entities: ${WRITE_ALLOWLIST.filter((e) => !DELETE_DENYLIST.includes(e)).join(", ")}.`);
    }
}
export async function queryRecords(opts) {
    const entity = assertEntityName(opts.entity);
    if (ALLOWED_ENTITIES.length && !ALLOWED_ENTITIES.includes(entity.toLowerCase())) {
        throw new McpError(ErrorCode.InvalidParams, `Entity '${entity}' is not in MCP_DYNAMICS_ALLOWED_ENTITIES (${ALLOWED_ENTITIES.join(", ")}).`);
    }
    const headers = {};
    if (opts.include_annotations)
        headers.Prefer = "odata.include-annotations=*";
    if (opts.fetchxml) {
        const params = new URLSearchParams({ fetchXml: opts.fetchxml });
        return send("get", `/${entity}?${params.toString()}`, { headers });
    }
    const params = {};
    if (opts.count)
        params["$count"] = "true";
    if (opts.filter)
        params["$filter"] = opts.filter;
    if (opts.select?.length)
        params["$select"] = opts.select.join(",");
    if (opts.expand?.length)
        params["$expand"] = opts.expand.join(",");
    if (opts.orderby)
        params["$orderby"] = opts.orderby;
    if (opts.top != null)
        params["$top"] = String(opts.top);
    if (opts.skip != null)
        params["$skip"] = String(opts.skip);
    const qs = new URLSearchParams(params).toString();
    const url = `/${entity}${qs ? `?${qs}` : ""}`;
    return send("get", url, { headers });
}
export async function queryAll(opts) {
    const maxPages = Math.max(1, opts.max_pages ?? DEFAULT_MAX_PAGES);
    const maxRecords = Math.min(opts.max_records ?? HARD_PAGE_CAP, Math.max(maxPages * MAX_PAGE_SIZE, MAX_PAGE_SIZE));
    const pageSize = Math.min(opts.page_size ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    const pages = [];
    let url;
    let count;
    // Première page : construit via queryRecords pour bénéficier de la validation.
    const first = await queryRecords({ ...opts, top: pageSize });
    pages.push(first.value);
    count = first["@odata.count"];
    url = first["@odata.nextLink"];
    let pageCount = 1;
    while (url && pageCount < maxPages) {
        const accumulated = pages.reduce((n, p) => n + p.length, 0);
        if (accumulated >= maxRecords)
            break;
        const api = await getClient();
        bumpDataverseCall();
        let next;
        try {
            const res = await api.request({
                method: "get",
                url,
                timeout: READ_TIMEOUT_MS,
            });
            next = res.data;
        }
        catch (err) {
            throw formatDataverseError(err, url);
        }
        pages.push(next.value);
        pageCount += 1;
        url = next["@odata.nextLink"];
    }
    const value = pages.flat();
    const total_records = count ?? value.length;
    const truncated = value.length < total_records || (url !== undefined && pageCount >= maxPages);
    return {
        value,
        "@odata.count": count,
        "@odata.nextLink": url,
        pages: pageCount,
        truncated,
        total_records,
        has_more: truncated,
    };
}
/**
 * H4 (FetchXML) : le FetchXML n'expose PAS de `@odata.nextLink` — la seule
 * façon de paginer est d'incrémenter `top`. Cette fonction loop jusqu'à
 * épuisement ou plafond, ce qui supprime le plafonnement silencieux à 500
 * lignes de get_forecast_summary (bug de production majeur : les totaux étaient
 * sous-estimés sans aucun avertissement).
 */
export async function queryAllFetchXml(opts) {
    const pageSize = Math.min(opts.page_size ?? 500, MAX_PAGE_SIZE);
    const maxPages = Math.max(1, opts.max_pages ?? DEFAULT_MAX_PAGES);
    const maxRecords = opts.max_records ?? maxPages * pageSize;
    const collected = [];
    let pages = 0;
    let truncated = false;
    while (pages < maxPages && collected.length < maxRecords) {
        const top = (pages + 1) * pageSize;
        const res = await queryRecords({
            entity: opts.entity,
            fetchxml: opts.buildFetch(top),
        });
        pages += 1;
        collected.push(...res.value);
        if (res.value.length < top) {
            break;
        }
        truncated = true;
    }
    const value = collected.length > maxRecords ? collected.slice(0, maxRecords) : collected;
    return {
        value,
        pages,
        truncated: truncated && value.length >= maxRecords,
        total_records: value.length,
        has_more: truncated,
    };
}
export async function getRecord(entity, id, select) {
    const e = assertEntityName(entity);
    const g = validateGuid(id, "id");
    const qs = select?.length ? `?$select=${encodeURIComponent(select.join(","))}` : "";
    return send("get", `/${e}(${g})${qs}`);
}
/**
 * C5 : ne retourne JAMAIS `""`. Silencieusement, `add_opportunity_product`
 * créait une ligne parente fantôme qu'il ne pouvait plus supprimer, et
 * `create_record` annonçait un succès avec `{id: ""}`.
 */
export async function createRecord(entity, data, select) {
    const e = assertEntityName(entity);
    const qs = select?.length ? `?$select=${encodeURIComponent(select.join(","))}` : "";
    // Appel direct plutôt que send() : il faut les EN-TÊTES (odata-entityid),
    // qui portent le GUID même quand Dataverse renvoie 204 sans corps.
    const api = await getClient();
    bumpDataverseCall();
    let res;
    try {
        const r = await api.request({
            method: "post",
            url: `/${e}${qs}`,
            data,
            timeout: WRITE_TIMEOUT_MS,
            headers: { Prefer: "return=representation" },
        });
        res = { data: r.data, headers: r.headers };
    }
    catch (err) {
        throw formatDataverseError(err, `/${e}`);
    }
    // 204 No Content renvoie "" : on normalise en objet avant de lire.
    const body = res.data && typeof res.data === "object" ? res.data : {};
    const headerHint = String(res.headers["odata-entityid"] ?? res.headers["location"] ?? res.headers["entityid"] ?? "");
    const location = body["@odata.id"] ?? body["@odata.etag"] ?? headerHint;
    // Regex stricte : 36 caractères hex + tirets.
    const match = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(String(location));
    let id = match?.[1]?.toLowerCase();
    // Repli : chercher la clé primaire dans le corps retourné.
    if (!id) {
        const primary = await getPrimaryIdAttribute(e);
        const fromBody = primary ? body[primary] : undefined;
        if (fromBody)
            id = String(fromBody).toLowerCase();
    }
    if (!id) {
        throw new McpError(ErrorCode.InternalError, `Create on '${e}' did not return a record GUID (Dataverse response had no usable id). The record MAY still have been created — verify with query_records(entity='${e}') before retrying, to avoid a duplicate.`);
    }
    return { id, representation: Object.keys(body).length ? body : undefined };
}
/** Met à jour et relit l'enregistrement (H17). */
export async function updateRecord(entity, id, data, rereadFields) {
    const e = assertEntityName(entity);
    const g = validateGuid(id, "id");
    const writtenRaw = await send("patch", `/${e}(${g})`, { data, headers: { Prefer: "return=representation" } }, true);
    const written = writtenRaw && typeof writtenRaw === "object" ? writtenRaw : undefined;
    // Dataverse ignore silencieusement les champs en lecture seule : on relit pour
    // confirmer champ par champ.
    if (rereadFields?.length) {
        try {
            return await getRecord(e, g, rereadFields);
        }
        catch {
            return written;
        }
    }
    return written;
}
export async function deleteRecord(entity, id) {
    const e = assertEntityName(entity);
    const g = validateGuid(id, "id");
    await send("delete", `/${e}(${g})`, {}, true);
}
// ---------------------------------------------------------------------------
// Métadonnées
// ---------------------------------------------------------------------------
const PRIMARY_ID_CACHE = new Map();
export async function getPrimaryIdAttribute(entity) {
    const cached = cacheGet(`primaryid:${entity}`);
    if (cached)
        return cached;
    const key = PRIMARY_ID_CACHE.get(entity);
    if (key)
        return key;
    return cacheWrap(`primaryid:${entity}`, 60_000, async () => {
        try {
            const meta = await getEntityMetadata(entity);
            const pid = meta?.PrimaryIdAttribute;
            if (typeof pid === "string" && pid) {
                PRIMARY_ID_CACHE.set(entity, pid);
                return pid;
            }
        }
        catch {
            /* métadonnées indisponibles : la création échouera avec un message clair */
        }
        return undefined;
    });
}
export async function getEntityMetadata(entity) {
    const e = assertEntityName(entity);
    const url = `/EntityDefinitions(LogicalName=${odataString(e)})` +
        `?$select=LogicalName,DisplayCollectionName,PrimaryIdAttribute,PrimaryNameAttribute,EntitySetName,IsCustomEntity,Description`;
    return send("get", url);
}
let whoAmICached = null;
export async function getCurrentUser() {
    if (whoAmICached)
        return whoAmICached;
    return cacheWrap("whoami", 60_000, async () => {
        const me = await send("get", "/WhoAmI");
        whoAmICached = me;
        return me;
    });
}
export async function resolveUserGuid(email) {
    if (!email)
        return (await getCurrentUser()).UserId;
    const e = email.trim();
    const cached = cacheGet(`user:${e.toLowerCase()}`);
    if (cached)
        return cached;
    return cacheWrap(`user:${e.toLowerCase()}`, 60_000, async () => {
        const result = await queryRecords({
            entity: "systemusers",
            filter: `internalemailaddress eq ${odataString(e)}`,
            select: ["systemuserid", "fullname"],
            top: 1,
        });
        const user = result.value[0];
        if (!user) {
            throw new McpError(ErrorCode.InvalidParams, `No Dynamics user found with email '${e}'. Verify the exact address (must be the Dataverse internalemailaddress), or omit 'email' to target the currently signed-in user.`);
        }
        return String(user["systemuserid"]).toLowerCase();
    });
}
/**
 * H8 : `list_entities` était non borné (plusieurs milliers d'entités avec
 * annotations) et renvoyait le LogicalName en guise de displayName, car
 * `DisplayCollectionName` est un `LocalizedLabels` ({ LocalizedLabels: [...] })
 * et ne contient PAS de propriete `UserLocalizedLabel`.
 */
export async function listEntities(opts = {}) {
    const top = Math.min(opts.top ?? 200, 1000);
    const conditions = ["IsIntersect eq false"];
    conditions.push(opts.onlyCustom ? "IsCustomEntity eq true" : "IsCustomizable/Value eq true");
    if (opts.search) {
        conditions.push(`contains(LogicalName,${odataString(opts.search)})`);
    }
    const params = new URLSearchParams({
        $select: "LogicalName,DisplayCollectionName,EntitySetName,IsCustomEntity",
        $filter: conditions.join(" and "),
        $orderby: "LogicalName asc",
        $top: String(top),
    });
    if (opts.count)
        params.set("$count", "true");
    const res = await send("get", `/EntityDefinitions?${params.toString()}`);
    const entities = res.value.map((e) => ({
        logicalName: e.LogicalName,
        displayName: labelOf(e.DisplayCollectionName) ?? e.LogicalName,
        entitySetName: e.EntitySetName,
        isCustom: !!e.IsCustomEntity,
    }));
    const total = res["@odata.count"];
    const has_more = total !== undefined ? entities.length < total : entities.length >= top;
    return { entities, has_more, total_count: total };
}
// ---------------------------------------------------------------------------
// Résolution dynamique des GUID instance-specific (M2)
// ---------------------------------------------------------------------------
/**
 * Résout le GUID de `transactioncurrencies` pour un code ISO.
 * Les GUID codés en dur étaient spécifiques à servicenow.crm.dynamics.com.
 */
export async function resolveCurrencyGuid(code) {
    const c = code.trim().toUpperCase();
    return cacheWrap(`currency:${c}`, 60_000, async () => {
        try {
            const res = await queryRecords({
                entity: "transactioncurrencies",
                filter: `transactioncurrencyidname eq ${odataString(c)} and isdisabled eq false`,
                select: ["transactioncurrencyid", "transactioncurrencyidname"],
                top: 1,
            });
            const hit = res.value[0]?.["transactioncurrencyid"];
            if (typeof hit === "string" && hit)
                return hit;
            throw new Error("no row");
        }
        catch (err) {
            const fallback = CURRENCY_GUIDS[c];
            if (fallback) {
                logJson({
                    event: "currency_resolve_fallback",
                    currency: c,
                    guid: fallback,
                    reason: err instanceof Error ? err.message : String(err),
                });
                return fallback;
            }
            throw new McpError(ErrorCode.InvalidParams, `Unknown currency '${c}'. The instance has no active transactioncurrencies row named '${c}' and no built-in fallback. Supported fallbacks: ${Object.keys(CURRENCY_GUIDS).join(", ")}.`);
        }
    });
}
/** Résout l'unité de mesure primaire de l'organisation (`isprimary eq true`). */
export async function resolvePrimaryUnitId() {
    return cacheWrap("uom:primary", 60_000, async () => {
        try {
            const res = await queryRecords({
                entity: "uoms",
                filter: "isprimary eq true",
                select: ["uomid", "name"],
                top: 1,
            });
            const hit = res.value[0]?.["uomid"];
            if (typeof hit === "string" && hit)
                return hit;
            throw new Error("no primary uom row");
        }
        catch (err) {
            logJson({
                event: "uom_resolve_fallback",
                guid: PRIMARY_UNIT_ID,
                reason: err instanceof Error ? err.message : String(err),
            });
            return PRIMARY_UNIT_ID;
        }
    });
}
/** Diagnostics d'environnement (utile pour `get_recent_tool_calls` / debug). */
export function environment() {
    return {
        instance_url: INSTANCE_URL,
        api_version: API_VERSION,
        readonly: READONLY,
        allowed_entities: ALLOWED_ENTITIES.length ? ALLOWED_ENTITIES : "all",
        default_query_rows: DEFAULT_QUERY_ROWS,
    };
}
/** Export interne pour les tests / diagnostics. */
export const __internal = {
    cacheSet,
    scrubServerMessage,
    retryDelay,
};
//# sourceMappingURL=dataverse.js.map