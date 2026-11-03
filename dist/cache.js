/**
 * Cache mémoire à TTL courte, borné (LRU).
 *
 * Les métadonnées Dataverse (schéma d'entité, valeurs de picklist, résolution
 * user/GUID) ne changent pas au cours d'une session de forecast : on évite
 * ainsi des allers-retours réseau répétés qui saturle le contexte du modèle.
 *
 * ⚠️ Le cache est BORNÉ : en transport HTTP (daemon multi-sessions) une Map
 * sans plafond croît indéfiniment. On plafonne à CACHE_MAX_ENTRIES et on purge
 * périodiquement les entrées expirées, sans bloquer la sortie du process.
 */
import { CACHE_TTL_MS, CACHE_MAX_ENTRIES } from "./constants.js";
const store = new Map();
/** Lit une valeur du cache, ou `undefined` si absente / expirée. */
export function cacheGet(key) {
    const hit = store.get(key);
    if (!hit)
        return undefined;
    if (hit.expires <= Date.now()) {
        store.delete(key);
        return undefined;
    }
    // LRU : on rafraîchit la position d'une entrée utilisée.
    store.delete(key);
    store.set(key, hit);
    return hit.value;
}
/** Écrit une valeur avec un TTL (60 s par défaut), en évacuant la plus ancienne. */
export function cacheSet(key, value, ttlMs = CACHE_TTL_MS) {
    if (store.has(key))
        store.delete(key);
    store.set(key, { value, expires: Date.now() + ttlMs });
    while (store.size > CACHE_MAX_ENTRIES) {
        const oldest = store.keys().next();
        if (oldest.done)
            break;
        store.delete(oldest.value);
    }
    return value;
}
/** Supprime les entrées expirées (appelée par la purge périodique). */
export function cachePrune() {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of store) {
        if (entry.expires <= now) {
            store.delete(key);
            removed += 1;
        }
    }
    return removed;
}
// Purge périodique : `unref()` pour ne jamais retenir le process en vie.
const pruneTimer = setInterval(() => cachePrune(), CACHE_TTL_MS);
if (typeof pruneTimer.unref === "function")
    pruneTimer.unref();
/**
 * Comme `cacheGet` mais déduplique les requêtes concurrentes : si la même clé
 * est demandée par deux appels parallèles, une seule requête part.
 */
const inFlight = new Map();
export async function cacheWrap(key, ttlMs, factory) {
    const cached = cacheGet(key);
    if (cached !== undefined)
        return cached;
    const pending = inFlight.get(key);
    if (pending)
        return pending;
    const promise = factory()
        .then((value) => cacheSet(key, value, ttlMs))
        .finally(() => {
        inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
}
/** Vide le cache (utile pour les tests et le mode readonly). */
export function cacheClear() {
    store.clear();
    inFlight.clear();
}
//# sourceMappingURL=cache.js.map