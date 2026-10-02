#!/usr/bin/env node
/**
 * Tests de la logique pure de la TUI (aucun serveur MCP requis).
 *
 *   node --experimental-strip-types tui/selftest.ts
 *
 * Couvre les briques qui ne dépendent pas du réseau : métriques/percentiles,
 * rendu ANSI, extraction d'entités du langage naturel et repli de JSON.
 */
import { guessToolCall, normalize, extractEntities } from "./nlp.ts";
import { computeStats, percentile, Metrics, fmtDuration, fmtUptime, fmtBytes } from "./metrics.ts";
import { clampText, formatToolResult } from "./format.ts";
import { padEnd, sparkline, Style, trunc, verticalBars } from "./render.ts";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    process.stdout.write(`  FAIL ${name}\n    attendu ${e}\n    obtenu  ${a}\n`);
  }
}

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) passed++;
  else {
    failed++;
    process.stdout.write(`  FAIL ${name} ${detail}\n`);
  }
}

/* ------------------------------------------------------------------ metrics */
{
  check("percentile p50 impair", percentile([1, 2, 3], 50), 2);
  check("percentile p50 pair", percentile([1, 2, 3, 4], 50), 2.5);
  check("percentile p100", percentile([1, 2, 3], 100), 3);
  check("percentile vide", percentile([], 95), 0);

  const s = computeStats([100, 200, 300, 400]);
  check("stats avg", s.avg, 250);
  check("stats min", s.min, 100);
  check("stats max", s.max, 400);
  check("stats vide", computeStats([]).count, 0);

  check("fmtDuration ms", fmtDuration(842), "842ms");
  check("fmtDuration s", fmtDuration(1240), "1.24s");
  check("fmtDuration min", fmtDuration(187_000), "3m07s");
  check("fmtUptime s", fmtUptime(5_000), "5s");
  check("fmtUptime h", fmtUptime(3_725_000), "1h02m05s");
  check("fmtBytes", fmtBytes(1536), "1.5KB");

  const m = new Metrics();
  m.record({ seq: 1, startedAt: 0, tool: "a", ok: true, durationMs: 10, argsBytes: 1, resultBytes: 2, tokens: 1 });
  m.record({ seq: 2, startedAt: 0, tool: "a", ok: false, durationMs: 20, error: "boom", argsBytes: 1, resultBytes: 2, tokens: 1 });
  m.record({ seq: 3, startedAt: 0, tool: "b", ok: true, durationMs: 30, argsBytes: 1, resultBytes: 2, tokens: 1 });
  check("metrics total", m.total, 3);
  check("metrics erreurs", m.errorCount, 1);
  ok("metrics taux erreur", Math.abs(m.stats().errorRate - 33.33) < 0.1, `${m.stats().errorRate}`);
  check("metrics erreurs recentes", m.recentErrors.length, 1);
  check("metrics par outil", m.byTool().map((t) => [t.tool, t.count]), [["a", 2], ["b", 1]]);
  ok("histogramme", m.histogram(3).reduce((n, h) => n + h.count, 0) === 3);
  check("timeline fenetre", m.timeline(2).length, 2);
}

/* ------------------------------------------------------------------- render */
{
  check("sparkline vide", sparkline([]), "");
  ok("sparkline 1 valeur", sparkline([5]) === "▁");
  ok("sparkline montant", sparkline([1, 5]) === "▁█");
  check("verticalBars vide", verticalBars([]), []);
  ok("verticalBars hauteur", verticalBars([1, 2, 3], 4).length === 4);
  ok("verticalBars largeur", verticalBars([1, 2, 3], 4).every((l) => l.length === 3));

  const s = new Style(false);
  check("Style sans ANSI", s.red("x"), "x");
  const c = new Style(true);
  ok("Style avec ANSI", c.red("x").includes("\x1b[31m"));
  check("trunc court", trunc("abc", 10), "abc");
  check("trunc long", trunc("abcdefgh", 4), "abc…");
  check("padEnd", padEnd("ab", 4), "ab  ");
}

/* ------------------------------------------------------------------- format */
{
  // Résultat MCP typique du dépôt : du JSON encapsulé dans content[].text.
  const result = {
    content: [{ type: "text", text: JSON.stringify({ value: [{ a: 1 }, { a: 2 }], "@odata.count": 2 }) }],
  };
  const out = formatToolResult(result);
  ok("format JSON replié", out.includes("\n  \"value\""), out.slice(0, 60));
  ok("format sans content", formatToolResult({ x: 1 }).includes("\"x\""));

  // Troncat un tableau trop long.
  const big = { content: [{ type: "text", text: JSON.stringify({ value: Array.from({ length: 500 }, (_, i) => i) }) }] };
  ok("format troncature tableau", formatToolResult(big, { maxItems: 10 }).includes("éléments"), "marker manquant");

  // Troncat un texte long.
  ok("clampText lignes", clampText("a\nb\nc\nd", 2, 100).includes("tronqué"));
  ok("clampText non tronqué", !clampText("court", 10, 100).includes("tronqué"));
}

/* ---------------------------------------------------------------------- nlp */
{
  check("normalize accents", normalize("Métadonnées de l'entité"), "metadonnees de l entite");

  const entities = extractEntities("les notes de OPTY5331870 chez a@b.com 26-Q3");
  ok("extrait OPTY", entities.includes("OPTY5331870"), JSON.stringify(entities));
  ok("extrait email", entities.includes("a@b.com"), JSON.stringify(entities));
  ok("extrait trimestre", entities.includes("26-Q3"), JSON.stringify(entities));
  ok("extrait guillemets", extractEntities("le compte \"Acme Corp\"").includes("Acme Corp"));
  ok(
    "extrait entite",
    extractEntities("les metadonnees de l'entite accounts").includes("accounts"),
    JSON.stringify(extractEntities("les metadonnees de l'entite accounts"))
  );
}

{
  // Mini-jeu d'outils représentatif du serveur réel.
  const T = (
    name: string,
    props: Record<string, import("./types.ts").JsonSchema>,
    required: string[] = [],
    description = ""
  ) => ({
    name,
    description,
    inputSchema: { type: "object" as const, properties: props, required },
  });
  const tools = [
    T("query_records", { entity: { type: "string" }, top: { type: "number" } }, ["entity"], "Query records from any entity using OData or FetchXML."),
    T("get_entity_metadata", { entity: { type: "string" } }, ["entity"], "Get metadata for an entity: primary key and name field."),
    T("list_entities", {}, [], "List all available entities (tables)."),
    T("get_my_opportunities", { status: { type: "string", enum: ["open", "won"] }, close_quarter: { type: "string" } }, [], "Get opportunities for a user, filter by status and close quarter."),
    T("search_opportunities", { query: { type: "string" }, top: { type: "number" } }, ["query"], "Search opportunities by name or account name."),
    T("get_opportunity_products", { opportunity_number: { type: "string" } }, [], "Get the product lines (SKUs) of an opportunity."),
    T("get_collaboration_notes", { opportunity_number: { type: "string" }, note_type: { type: "string", enum: ["Next Steps", "Win/Loss"] } }, [], "Get Collaboration Notes for an opportunity."),
    T("create_record", { entity: { type: "string" }, data: { type: "object" } }, ["entity", "data"], "Create a new record."),
    T("delete_record", { entity: { type: "string" }, id: { type: "string" } }, ["entity", "id"], "Delete a record."),
    T("get_at_risk_deals", { close_quarter: { type: "string" }, stale_days: { type: "number" } }, [], "Get open deals at risk: overdue, stale or misaligned."),
  ];

  const cases: Array<[string, string]> = [
    ["metadonnees de l'entite accounts", "get_entity_metadata"],
    ["quelles sont les tables disponibles", "list_entities"],
    ["produits de l'opportunite OPTY5331870", "get_opportunity_products"],
    ["notes de collaboration de OPTY5331870 de type Win/Loss", "get_collaboration_notes"],
    ["deals a risque du trimestre 26-Q3", "get_at_risk_deals"],
    ["cree un enregistrement dans accounts", "create_record"],
    ["supprime l'enregistrement accounts", "delete_record"],
  ];
  for (const [q, expected] of cases) {
    const g = guessToolCall(q, tools);
    ok(`nlp: « ${q} »`, g?.tool === expected, `→ ${g?.tool ?? "aucun"} (attendu ${expected})`);
  }

  // Outil nommé explicitement : confiance 1, aucunCas ambiguïté possible.
  const explicit = guessToolCall("appelle list_entities", tools);
  check("nlp nom explicite", explicit?.tool, "list_entities");
  check("nlp confiance explicite", explicit?.confidence, 1);

  // Phrase incompréhensible -> aucun appel proposé.
  check("nlp incompréhensible", guessToolCall("xyzzy plugh", tools), null);

  // Extraction des arguments d'un tool().
  const metaTool = tools[1];
  const args = guessToolCall("metadonnees de l'entite accounts", tools)?.args;
  check("nlp args entity", args?.entity, "accounts");
  void metaTool;

  const risk = guessToolCall("deals a risque du trimestre 26-Q3", tools)?.args;
  check("nlp args close_quarter", risk?.close_quarter, "26-Q3");

  const notes = guessToolCall("notes de OPTY5331870 de type Win/Loss", tools)?.args;
  check("nlp args opportunity_number", notes?.opportunity_number, "OPTY5331870");
  check("nlp args enum", notes?.note_type, "Win/Loss");

  // Valeur extraite mais jamais proposée : rien ne doit être inventé.
  const atRisk = guessToolCall("deals a risque sans stale", tools)?.args;
  check("nlp n'invente pas stale_days", atRisk?.stale_days, undefined);
}

process.stdout.write(
  `\n${failed === 0 ? "OK" : "ÉCHECS"} — ${passed} assertions passées, ${failed} échouées\n`
);
process.exitCode = failed === 0 ? 0 : 1;