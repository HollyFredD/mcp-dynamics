/**
 * Observabilité.
 *
 * ⚠️ RÈGLE ABSOLUE : tout ce module écrit sur **stderr** uniquement. stdout
 * porte le protocole JSON-RPC du serveur MCP ; le polluer casse le handshake.
 */
const MAX_ENTRIES = 200;
const recent = [];
let dataverseCalls = 0;
/** Incrémente le compteur d'appels Dataverse (reset au début de chaque outil). */
export function bumpDataverseCall(n = 1) {
    dataverseCalls += n;
    return dataverseCalls;
}
export function resetDataverseCalls() {
    dataverseCalls = 0;
}
export function dataverseCallCount() {
    return dataverseCalls;
}
/** Écrit une ligne JSON de log sur stderr. */
export function logJson(event) {
    try {
        process.stderr.write(`${JSON.stringify(event)}\n`);
    }
    catch {
        /* stderr fermé : on ne casse jamais l'outil pour un log */
    }
}
/** Enregistre le résultat d'un appel d'outil (mémoire + stderr). */
export function logToolCall(entry) {
    recent.push(entry);
    if (recent.length > MAX_ENTRIES)
        recent.splice(0, recent.length - MAX_ENTRIES);
    logJson({ event: "tool_call", ...entry });
}
/** Historique des appels d'outils, le plus récent en premier. */
export function recentToolCalls(limit) {
    return recent.slice(-limit).reverse();
}
/** Rédaction des secrets avant écriture dans un message d'erreur. */
export function redact(s) {
    return s
        .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer <redacted>")
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
        .slice(0, 400);
}
//# sourceMappingURL=log.js.map