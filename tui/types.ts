/**
 * Types partagés par la TUI.
 *
 * Aucun import depuis `src/` : la TUI est totalement découplée du serveur MCP
 * (elle ne fait que l'observer via stdio), ce qui permet de la faire évoluer
 * sans toucher au serveur.
 */

/** Protocole MCP implémenté par le serveur (voir @modelcontextprotocol/sdk). */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Un outil tel qu'exposé par `tools/list`. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

/** Sous-ensemble de JSON Schema suffisant pour construire un formulaire. */
export interface JsonSchema {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean;
}

/** Enveloppe JSON-RPC 2.0 (MCP l'utilise sur stdio). */
export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Résultat d'un appel d'outil (`tools/call`). */
export interface ToolCallResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  structuredContent?: unknown;
  [k: string]: unknown;
}

/** États possibles du serveur enfant. */
export type ServerState = "connecting" | "ready" | "crashed" | "stopped";

/** Un appel d'outil instrumenté — l'unité de base du dashboard et des logs. */
export interface CallRecord {
  /** id numérique croissant, sert de numéro de séquence dans la timeline. */
  seq: number;
  /** timestamp epoch (ms) du début de l'appel */
  startedAt: number;
  /** nom de l'outil (ou "unknown") */
  tool: string;
  ok: boolean;
  durationMs: number;
  /** message d'erreur si ok === false */
  error?: string;
  /** taille (octets) des arguments sérialisés */
  argsBytes: number;
  /** taille (octets) du résultat sérialisé */
  resultBytes: number;
  /**
   * Estimation grossière du nombre de tokens échangés.
   * Le transport stdio ne transporte pas de métadonnées de tokens : on approxime
   * avec ~4 caractères par token, ce qui suffit largement pour comparer
   * des scénarios (perte de précision < 15 %).
   */
  tokens: number;
  /** false si l'appel a été interrompu (Ctrl+C / timeout) */
  interrupted?: boolean;
}

/** Événements NDJSON écrits dans le fichier de log de session. */
export type LogEvent =
  | { type: "session_start"; ts: number; pid: number; argv: string[]; config: Record<string, unknown> }
  | { type: "session_end"; ts: number; reason: string }
  | { type: "server_spawn"; ts: number; command: string; args: string[]; pid?: number }
  | { type: "server_exit"; ts: number; code: number | null; signal: string | null }
  | { type: "stderr"; ts: number; line: string }
  | { type: "stdout_raw"; ts: number; bytes: number }
  | { type: "rpc_request"; ts: number; id: number; method: string; params?: unknown; bytes: number }
  | { type: "rpc_response"; ts: number; id: number; ok: boolean; durationMs: number; bytes: number; error?: string }
  | { type: "rpc_notification"; ts: number; method: string }
  | { type: "call"; ts: number; record: CallRecord }
  | { type: "error"; ts: number; scope: string; message: string }
  | { type: "info"; ts: number; message: string };

/** Un enregistrement brut lu par `--replay`. */
export type ReplayEvent = LogEvent & { seq?: number };