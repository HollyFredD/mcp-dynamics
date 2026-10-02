/**
 * Helpers de rendu ANSI. Aucune dépendance : on pilote directement les
 * séquences d'échappement dont on a besoin (alternate screen, cursor, couleurs).
 *
 * Le mode couleur est désactivé automatiquement si stdout n'est pas un TTY ou si
 * NO_COLOR est défini (https://no-color.org), pour que la sortie reste propre
 * dans un pipe / un fichier de log.
 */

const NO_COLOR = !!process.env.NO_COLOR || process.env.TERM === "dumb";

function supportsAnsi(stream: NodeJS.WriteStream): boolean {
  return !!stream.isTTY && !NO_COLOR;
}

export type Stream = NodeJS.WriteStream;

export class Style {
  readonly ansi: boolean;
  constructor(stream: Stream | boolean = process.stdout) {
    this.ansi = typeof stream === "boolean" ? stream : supportsAnsi(stream);
  }

  private c(code: string, s: string): string {
    return this.ansi ? `\x1b[${code}m${s}\x1b[0m` : s;
  }

  bold(s: string): string { return this.c("1", s); }
  dim(s: string): string { return this.c("2", s); }
  red(s: string): string { return this.c("31", s); }
  green(s: string): string { return this.c("32", s); }
  yellow(s: string): string { return this.c("33", s); }
  blue(s: string): string { return this.c("34", s); }
  magenta(s: string): string { return this.c("35", s); }
  cyan(s: string): string { return this.c("36", s); }
  gray(s: string): string { return this.c("90", s); }
  boldCyan(s: string): string { return this.ansi ? `\x1b[1;36m${s}\x1b[0m` : s; }
  boldYellow(s: string): string { return this.ansi ? `\x1b[1;33m${s}\x1b[0m` : s; }
  boldRed(s: string): string { return this.ansi ? `\x1b[1;31m${s}\x1b[0m` : s; }
  inverse(s: string): string { return this.c("7", s); }
}

// Séquences de contrôle de l'écran réutilisées telles quelles.
export const ESC = {
  altScreenOn: "\x1b[?1049h",
  altScreenOff: "\x1b[?1049l",
  clearScreen: "\x1b[2J",
  home: "\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  clearLine: "\x1b[2K",
  reset: "\x1b[0m",
};

export function clearScreen(stream: Stream): void {
  stream.write(ESC.home + ESC.clearScreen);
}

/** Largeur terminal avec repli sûr quand stdout n'est pas un TTY. */
export function termWidth(stream: Stream = process.stdout, fallback = 100): number {
  return Math.max(60, Math.min(stream.columns ?? fallback, 160));
}

/** Tronque au nombre de caractères visibles (approxime : on ignore l'ANSI). */
export function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Tronque une ligne sur place en préservant les codes ANSI de fin. */
export function trunc(s: string, max: number): string {
  if (visibleLen(s) <= max) return s;
  // On coupe au nombre de caractères *visibles* max-1 puis on ajoute "…".
  let out = "";
  let count = 0;
  let inAnsi = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\x1b") { inAnsi = true; out += ch; continue; }
    if (inAnsi) {
      out += ch;
      if (ch === "m") inAnsi = false;
      continue;
    }
    if (count >= max - 1) return out + "…";
    out += ch;
    count++;
  }
  return out;
}

/** Complète une ligne jusqu'à `width` (avec ANSI-awareness approximatif). */
export function padEnd(s: string, width: number): string {
  const pad = width - visibleLen(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

export function padStart(s: string, width: number): string {
  const pad = width - visibleLen(s);
  return pad > 0 ? " ".repeat(pad) + s : s;
}

/** Blocs Unicode pour la timeline (blocs pleins en demi-hauteurs). */
export const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
export const BAR_FULL = "█";
export const BAR_EMPTY = "░";

/** Sparkline : une valeur -> un caractère de bloc selon sa position dans le range. */
export function sparkline(values: number[], width = 50): string {
  if (values.length === 0) return "";
  const data = values.slice(-width);
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min;
  return data
    .map((v) => {
      if (span === 0) return SPARK[0];
      const idx = Math.round(((v - min) / span) * (SPARK.length - 1));
      return SPARK[Math.max(0, Math.min(SPARK.length - 1, idx))];
    })
    .join("");
}

/**
 * Histogramme vertical ASCII des N derniers appels.
 * Chaque colonne = un appel ; hauteur = durée normalisée sur `height`.
 */
export function verticalBars(values: number[], height = 8): string[] {
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const lines: string[] = [];
  const top = Math.max(max, 1);
  for (let row = height - 1; row >= 0; row--) {
    const threshold = (row / height) * top;
    let line = "";
    for (const v of values) {
      const filled = v >= threshold * (row === 0 ? 0 : 1) && v > 0;
      line += filled ? BAR_FULL : BAR_EMPTY;
    }
    lines.push(line);
  }
  return lines;
}

/** Étiquette temporelle sous un histogramme : début → fin. */
export function timelineLabels(count: number): string {
  if (count === 0) return "";
  return `${String(count).padStart(3, " ")} appels (ancien → récent)`;
}