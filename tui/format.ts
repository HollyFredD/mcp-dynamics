import { trunc } from "./render.ts";

/**
 * Affichage "raw" d'un résultat d'outil MCP.
 *
 * Les outils de ce dépôt renvoient `{ content: [{ type: "text", text: "<json>" }] }`
 * (cf. records.ts). On tente donc de re-parse le text pour le montrer replié
 * proprement ; sinon on affiche le texte tel quel, tronqué.
 */

export interface FormatOptions {
  maxDepth?: number;
  maxItems?: number;
  maxString?: number;
  maxLines?: number;
  indent?: number;
}

const DEFAULTS: Required<FormatOptions> = {
  maxDepth: 8,
  maxItems: 20,
  maxString: 400,
  maxLines: 200,
  indent: 2,
};

/** Réduit une profondeur d'objet pour l'affichage (indique les omissions). */
function shrink(value: unknown, depth: number, opts: Required<FormatOptions>): unknown {
  if (depth >= opts.maxDepth) return "…(profondeur max)";
  if (typeof value === "string" && value.length > opts.maxString) {
    return `${value.slice(0, opts.maxString)}…(+${value.length - opts.maxString} car.)`;
  }
  if (Array.isArray(value)) {
    if (value.length > opts.maxItems) {
      const head = value.slice(0, opts.maxItems).map((v) => shrink(v, depth + 1, opts));
      head.push(`…(+${value.length - opts.maxItems} éléments)`);
      return head;
    }
    return value.map((v) => shrink(v, depth + 1, opts));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries.slice(0, opts.maxItems)) {
      out[k] = shrink(v, depth + 1, opts);
    }
    if (entries.length > opts.maxItems) {
      out["…"] = `(+${entries.length - opts.maxItems} clés)`;
    }
    return out;
  }
  return value;
}

/** Extrait le texte utile d'un résultat MCP (content[].text). */
export function extractText(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown };
  if (Array.isArray(r.content) && r.content.length > 0) {
    return r.content
      .map((c) => (typeof c.text === "string" ? c.text : `[${c.type ?? "?"} non textuel]`))
      .join("\n");
  }
  if (r.structuredContent !== undefined) return JSON.stringify(r.structuredContent, null, 2);
  return null;
}

/** Formate un résultat d'appel d'outil pour l'affichage console. */
export function formatToolResult(result: unknown, opts: FormatOptions = {}): string {
  const o = { ...DEFAULTS, ...opts };
  const text = extractText(result);
  if (text === null) {
    return JSON.stringify(shrink(result, 0, o), null, o.indent);
  }
  // Les outils du dépôt encapsulent du JSON dans le text : on tente un repli.
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return JSON.stringify(shrink(parsed, 0, o), null, o.indent);
    } catch {
      /* pas du JSON : on affiche le texte brut */
    }
  }
  return text;
}

/** Tronque proprement un texte long sur N lignes + N caractères. */
export function clampText(s: string, maxLines: number, maxChars: number): string {
  const lines = s.split("\n");
  let out = lines.slice(0, maxLines);
  let truncated = false;
  if (lines.length > maxLines) truncated = true;
  let text = out.join("\n");
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  if (truncated) text += `\n… (résultat tronqué — log NDJSON complet dispo via 'l')`;
  return text;
}

/** Une ligne compacte pour la timeline du dashboard. */
export function compactLine(s: string, width: number): string {
  return trunc(s.replace(/\s+/g, " ").trim(), width);
}