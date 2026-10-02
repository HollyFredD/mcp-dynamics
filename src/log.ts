/**
 * Observabilité.
 *
 * ⚠️ RÈGLE ABSOLUE : tout ce module écrit sur **stderr** uniquement. stdout
 * porte le protocole JSON-RPC du serveur MCP ; le polluer casse le handshake.
 */

export interface ToolCallLog {
  /** Horodatage ISO. */
  ts: string;
  tool: string;
  duration_ms: number;
  ok: boolean;
  /** Message d'erreur (court, jamais de $filter brut). */
  error?: string;
  /** Nombre de lignes renvoyées, quand pertinent. */
  rows?: number;
  /** Nombre d'appels HTTP Dataverse déclenchés par l'invocation. */
  dataverse_calls?: number;
}

const MAX_ENTRIES = 200;
const recent: ToolCallLog[] = [];

let dataverseCalls = 0;

/** Incrémente le compteur d'appels Dataverse (reset au début de chaque outil). */
export function bumpDataverseCall(n = 1): number {
  dataverseCalls += n;
  return dataverseCalls;
}

export function resetDataverseCalls(): void {
  dataverseCalls = 0;
}

export function dataverseCallCount(): number {
  return dataverseCalls;
}

/** Écrit une ligne JSON de log sur stderr. */
export function logJson(event: Record<string, unknown>): void {
  try {
    process.stderr.write(`${JSON.stringify(event)}\n`);
  } catch {
    /* stderr fermé : on ne casse jamais l'outil pour un log */
  }
}

/** Enregistre le résultat d'un appel d'outil (mémoire + stderr). */
export function logToolCall(entry: ToolCallLog): void {
  recent.push(entry);
  if (recent.length > MAX_ENTRIES) recent.splice(0, recent.length - MAX_ENTRIES);
  logJson({ event: "tool_call", ...entry });
}

/** Historique des appels d'outils, le plus récent en premier. */
export function recentToolCalls(limit: number): ToolCallLog[] {
  return recent.slice(-limit).reverse();
}

/** Rédaction des secrets avant écriture dans un message d'erreur. */
export function redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer <redacted>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .slice(0, 400);
}