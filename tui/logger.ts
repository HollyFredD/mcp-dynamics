import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { LogEvent } from "./types.ts";

/**
 * `Omit` ne se distribue pas sur une union : sans cette aide, `Omit<LogEvent,
 * "ts">` ne garderait que les clés communes à toutes les variantes et le
 * typage des événements deviendrait inutilisable.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Un événement prêt à journaliser : `ts` est optionnel (injecté par le logger). */
export type LogInput = DistributiveOmit<LogEvent, "ts"> & { ts?: number };

/**
 * Journal de session en NDJSON (une ligne JSON par événement).
 *
 * Pourquoi NDJSON : c'est streamable (`grep`, `jq`, `tail -f`) tout en restant
 * rejouable par `--replay`. Un seul fichier par session, horodaté et PID-suffiqué
 * pour ne jamais écraser une session précédente.
 */
export class SessionLogger {
  private stream: WriteStream | null = null;
  /** Chemin du fichier NDJSON, `null` si le logger est désactivé. */
  readonly file: string | null = null;

  constructor(
    logDir: string,
    sessionLabel = "tui",
    pid = process.pid,
    enabled = true
  ) {
    if (!enabled) return; // logger no-op : aucun fichier ouvert
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.file = join(logDir, `${stamp}_${sessionLabel}_${pid}.ndjson`);
    try {
      mkdirSync(logDir, { recursive: true });
      this.stream = createWriteStream(this.file, { flags: "a" });
      this.stream.on("error", (err) => {
        // Ne jamais planter la TUI parce que le disque est plein / read-only.
        this.stream = null;
        process.stderr.write(`[tui] écriture log impossible: ${err.message}\n`);
      });
    } catch (err) {
      process.stderr.write(
        `[tui] dossier de logs inaccessible (${logDir}): ${(err as Error).message}\n`
      );
    }
  }

  /** Écrit un événement. `ts` est toujours injecté par le logger. */
  log(event: LogInput): void {
    if (!this.stream) return;
    try {
      this.stream.write(JSON.stringify({ ts: event.ts ?? Date.now(), ...event }) + "\n");
    } catch {
      /* stream cassé : on continue sans log */
    }
  }

  info(message: string): void {
    this.log({ type: "info", message });
  }

  error(scope: string, message: string): void {
    this.log({ type: "error", scope, message });
  }

  close(reason = "exit"): void {
    this.log({ type: "session_end", reason });
    this.stream?.end();
    this.stream = null;
  }
}

/**
 * Logger no-op : utilisé par `--replay` (analyse hors-ligne) et quand le log
 * est explicitement désactivé. On n'ouvre aucun fichier.
 */
export function createNullLogger(): SessionLogger {
  return new SessionLogger("", "null", process.pid, false);
}