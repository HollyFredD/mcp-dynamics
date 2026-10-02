/**
 * Cache mémoire à TTL courte.
 *
 * Les métadonnées Dataverse (schéma d'entité, valeurs de picklist, résolution
 * user/GUID) ne changent pas au cours d'une session de forecast : on évite
 * ainsi des allers-retours réseau répétés qui sature le contexte du modèle.
 */
import { CACHE_TTL_MS } from "./constants.js";
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
    return hit.value;
}
/** Écrit une valeur avec un TTL (60 s par défaut). */
export function cacheSet(key, value, ttlMs = CACHE_TTL_MS) {
    store.set(key, { value, expires: Date.now() + ttlMs });
    return value;
}
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