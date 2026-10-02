/**
 * Cache mémoire à TTL courte.
 *
 * Les métadonnées Dataverse (schéma d'entité, valeurs de picklist, résolution
 * user/GUID) ne changent pas au cours d'une session de forecast : on évite
 * ainsi des allers-retours réseau répétés qui sature le contexte du modèle.
 */
import { CACHE_TTL_MS } from "./constants.js";

interface Entry<T> {
  value: T;
  expires: number;
}

const store = new Map<string, Entry<unknown>>();

/** Lit une valeur du cache, ou `undefined` si absente / expirée. */
export function cacheGet<T>(key: string): T | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value as T;
}

/** Écrit une valeur avec un TTL (60 s par défaut). */
export function cacheSet<T>(key: string, value: T, ttlMs: number = CACHE_TTL_MS): T {
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

/**
 * Comme `cacheGet` mais déduplique les requêtes concurrentes : si la même clé
 * est demandée par deux appels parallèles, une seule requête part.
 */
const inFlight = new Map<string, Promise<unknown>>();

export async function cacheWrap<T>(
  key: string,
  ttlMs: number,
  factory: () => Promise<T>
): Promise<T> {
  const cached = cacheGet<T>(key);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = factory()
    .then((value) => cacheSet(key, value, ttlMs))
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

/** Vide le cache (utile pour les tests et le mode readonly). */
export function cacheClear(): void {
  store.clear();
  inFlight.clear();
}