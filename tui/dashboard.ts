import { fmtBytes, fmtDuration, fmtNum, fmtUptime, TIMELINE_WINDOW, type Metrics } from "./metrics.ts";
import {
  ESC,
  padEnd,
  padStart,
  sparkline,
  Style,
  termWidth,
  timelineLabels,
  trunc,
  verticalBars,
  type Stream,
} from "./render.ts";
import type { ServerState } from "./types.ts";

export interface DashboardInput {
  metrics: Metrics;
  state: ServerState;
  serverName: string;
  serverVersion: string;
  toolCount: number;
  instanceUrl: string;
  instanceSource: string;
  logFile: string | null;
  stderrLines: string[];
  sessionLabel: string;
  crashInfo: string | null;
  /** note explicite p.ex. "stdout non-TTY: dashboard désactivé". */
  note?: string;
}

/**
 * Dashboard temps réel.
 *
 * Rendu « full redraw » : on revient en haut (`ESC.home`) et on efface tout
 * (`ESC.clearScreen`) à chaque frame. C'est plus simple et sans artefact de
 * scroll qu'un redraw à base de curseur, et à 2 Hz le flicker est imperceptible.
 */
export class Dashboard {
  private readonly style: Style;
  private readonly stream: Stream;
  private readonly input: () => DashboardInput;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private lastFrame = 0;

  // Champs explicites plutôt que "parameter properties" : le mode strip-only de
  // Node (utilisé par le script npm « tui ») ne supporte pas cette syntaxe.
  constructor(stream: Stream, input: () => DashboardInput, intervalMs: number) {
    this.stream = stream;
    this.input = input;
    this.intervalMs = intervalMs;
    this.style = new Style(stream);
  }

  start(): void {
    if (this.stream.isTTY) {
      this.stream.write(ESC.altScreenOn + ESC.hideCursor);
      this.stream.on("resize", this.onResize);
    }
    this.draw();
    this.timer = setInterval(() => this.draw(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stream.isTTY) {
      this.stream.write(ESC.showCursor + ESC.altScreenOff);
      this.stream.off("resize", this.onResize);
    }
  }

  private onResize = (): void => {
    this.lastFrame = 0; // force un redraw immédiat
  };

  draw(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastFrame < Math.floor(this.intervalMs / 2)) return;
    this.lastFrame = now;
    const width = termWidth(this.stream);
    const lines = this.render(width);
    this.stream.write(ESC.home + ESC.clearScreen + lines.join("\r\n") + "\r\n");
  }

  private render(width: number): string[] {
    const d = this.input();
    const s = this.style;
    const W = width - 1;
    const out: string[] = [];

    out.push(s.boldCyan("╔" + "═".repeat(W) + "╗"));
    const title = ` MCP DYNAMICS TUI — ${d.sessionLabel} `;
    out.push(
      "║" +
        s.boldCyan(padEnd(title, W)) +
        "║"
    );
    out.push(s.boldCyan("╚" + "═".repeat(W) + "╝"));

    // --- Bloc connexion ---------------------------------------------------
    out.push("");
    out.push("  " + this.stateBadge(d));
    const info: Array<[string, string]> = [
      ["serveur", `${d.serverName} v${d.serverVersion}`],
      ["outils", String(d.toolCount)],
      ["instance", `${d.instanceUrl}  ${s.dim(`(${d.instanceSource})`)}`],
      ["session", `uptime ${s.bold(fmtUptime(d.metrics.uptimeMs()))} · log ${s.dim(d.logFile ?? "(désactivé)")}`],
    ];
    for (const [k, v] of info) out.push(`    ${s.gray(padEnd(k, 9))} ${v}`);

    // --- Bloc métriques globales ------------------------------------------
    const st = d.metrics.stats();
    out.push("");
    out.push("  " + s.bold("MÉTRIQUES") + s.gray(`  (fenêtre totale · ${st.count} appels)`));
    const cells: Array<[string, string]> = [
      ["appels", String(st.count)],
      ["erreurs", `${st.errors} (${st.errorRate.toFixed(1)}%)`],
      ["en vol", String(d.metrics.inFlight)],
      ["moyenne", fmtDuration(st.avg)],
      ["p50", fmtDuration(st.p50)],
      ["p95", fmtDuration(st.p95)],
      ["max", fmtDuration(st.max)],
    ];
    out.push("    " + this.kvCells(cells, W - 4));
    out.push(
      "    " +
        s.gray("trafic ") +
        fmtBytes(st.bytes) +
        s.gray("  tokens≈") +
        fmtNum(st.tokens) +
        s.gray("  échecs ") +
        (st.errorRate > 20 ? s.red(`${st.errorRate.toFixed(0)}% ⚠`) : s.green(`${st.errorRate.toFixed(0)}%`))
    );

    // --- Top outils --------------------------------------------------------
    out.push("");
    out.push("  " + s.bold("TOP OUTILS") + s.gray("  (par nombre d'appels)"));
    const byTool = d.metrics.byTool(8);
    if (byTool.length === 0) {
      out.push("    " + s.dim("aucun appel pour l'instant"));
    } else {
      out.push(
        s.gray(
          padEnd("    outil", 30) + padStart("n", 4) + padStart("err", 5) + padStart("moy", 9) + padStart("p95", 9) + padStart("octets", 10)
        )
      );
      for (const t of byTool) {
        const name = trunc(t.tool, 28);
        out.push(
          "    " +
            padEnd(name, 30) +
            padStart(String(t.count), 4) +
            padStart(t.errors ? s.red(String(t.errors)) : "0", 5) +
            padStart(fmtDuration(t.avg), 9) +
            padStart(fmtDuration(t.p95), 9) +
            padStart(fmtBytes(t.bytes), 10)
        );
      }
    }

    // --- Timeline des 50 derniers appels -----------------------------------
    out.push("");
    out.push("  " + s.bold(`TIMELINE — durées des ${TIMELINE_WINDOW} derniers appels`));
    const tl = d.metrics.timeline(TIMELINE_WINDOW);
    if (tl.length === 0) {
      out.push("    " + s.dim("en attente du premier appel…"));
    } else {
      // 2 colonnes par appel : 100 appels -> 200 colonnes, on plafonne à la largeur.
      const maxCalls = Math.max(1, Math.floor((W - 6) / 2));
      const shown = tl.slice(-maxCalls);
      const shownBars = verticalBars(shown.map((r) => r.durationMs), 6);
      const scale = `${Math.round(shown[0].durationMs)}ms → ${Math.round(shown[shown.length - 1].durationMs)}ms`;
      out.push(s.gray(`    échelle: ${scale}  (plein = lent, vide = rapide)`));
      for (const line of shownBars) out.push("    " + line.replace(/(.)/g, "$1$1"));
      out.push(
        "    " +
          s.gray("spark ") +
          sparkline(shown.map((r) => r.durationMs), maxCalls) +
          "  " +
          s.gray(timelineLabels(shown.length))
      );
      // 5 derniers appels en clair
      for (const r of tl.slice(-5)) {
        const when = new Date(r.startedAt).toISOString().slice(11, 19);
        const badge = r.ok ? s.green("OK  ") : s.red("ERR ");
        const err = r.error ? s.red(` — ${trunc(r.error, W - 46)}`) : "";
        out.push(
          `    ${s.gray(when)} ${badge} ${padEnd(trunc(r.tool, 30), 30)} ${padStart(fmtDuration(r.durationMs), 8)} ${s.dim(fmtBytes(r.resultBytes + r.argsBytes))}${err}`
        );
      }
    }

    // --- Erreurs récentes --------------------------------------------------
    out.push("");
    out.push("  " + s.bold("ERREURS RÉCENTES"));
    if (d.metrics.recentErrors.length === 0) {
      out.push("    " + s.green("aucune erreur"));
    } else {
      for (const e of d.metrics.recentErrors.slice(-3).reverse()) {
        const when = new Date(e.startedAt).toISOString().slice(11, 19);
        out.push(`    ${s.gray(when)} ${s.red(e.tool)} ${s.dim(fmtDuration(e.durationMs))} ${trunc(e.message, W - 30)}`);
      }
    }

    // --- stderr serveur ----------------------------------------------------
    if (d.stderrLines.length > 0) {
      out.push("");
      out.push("  " + s.bold("STDERR SERVEUR") + s.gray("  (dernières lignes)"));
      for (const l of d.stderrLines.slice(-3)) {
        out.push("    " + s.dim(trunc(l, W - 4)));
      }
    }

    if (d.crashInfo) {
      out.push("");
      out.push("  " + s.boldRed("SERVEUR ARRÊTÉ : ") + s.red(d.crashInfo));
      out.push("  " + s.dim("appuyez sur 'r' pour relancer, 'q' pour quitter"));
    }
    if (d.note) {
      out.push("");
      out.push("  " + s.yellow(d.note));
    }

    // --- Barre de touches --------------------------------------------------
    out.push("");
    out.push(
      "  " +
        s.inverse(
          padEnd(
            ` c console  t outils  r relancer  e erreurs  l log  w watch  ? aide  q quitter `,
            W
          )
        )
    );
    return out;
  }

  private stateBadge(d: DashboardInput): string {
    const s = this.style;
    switch (d.state) {
      case "ready":
        return s.green("● CONNECTÉ") + s.dim(` — ${d.toolCount} outils exposés, handshake MCP OK`);
      case "connecting":
        return s.yellow("● CONNEXION…") + s.dim(" — handshake initialize en cours");
      case "crashed":
        return s.boldRed("● CRASH") + s.dim(` — ${d.crashInfo ?? "code inconnu"}`);
      default:
        return s.gray("○ ARRÊTÉ");
    }
  }

  /** Deux colonnes "clé: valeur" pour tenir sur une ligne. */
  private kvCells(cells: Array<[string, string]>, width: number): string {
    const s = this.style;
    const colW = Math.floor(width / 3);
    const rows: string[] = [];
    for (let i = 0; i < cells.length; i += 3) {
      const chunk = cells.slice(i, i + 3);
      rows.push(
        chunk
          .map(([k, v]) => s.gray(padEnd(k, 9)) + padEnd(v, colW))
          .join("")
          .trimEnd()
      );
    }
    return rows.join("\r\n    ");
  }
}