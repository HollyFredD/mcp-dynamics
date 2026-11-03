/**
 * Tests unitaires (node --test, zéro dépendance).
 *
 * Couvre les correctifs des lots 1–3 : builders FetchXML (échappement,
 * pagination), retry idempotent, flags de troncature, vérification d'écriture,
 * sérialisation bornée, validation et cache LRU.
 *
 *   node --test --experimental-strip-types test/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  condition,
  filter,
  fetchXml,
  withTop,
  withPaging,
} from "../src/fetchxml.ts";
import { serializeResult, verifyWrite, decorateProbability, probabilityToNumber } from "../src/tools/common.ts";
import { oneOf, intIn, entityName } from "../src/validate.ts";
import { guid, odataString, assertEntityName } from "../src/odata.ts";
import { normalizeQuarter, currentQuarter, quarterOfDate } from "../src/dates.ts";
import { cacheSet, cacheGet, cachePrune } from "../src/cache.ts";

// ---------------------------------------------------------------------------
// FetchXML : échappement et injection
// ---------------------------------------------------------------------------

test("condition: échappe les guillemets de valeur", () => {
  const xml = condition({ attribute: "name", value: 'ACME "quoted"' });
  assert.match(xml, /value="ACME &quot;quoted&quot;"/);
});

test("condition: apostrophe doublée dans odataString", () => {
  assert.equal(odataString("L'Oréal"), "'L''Oréal'");
});

test("condition: filtre sur entité liée émet entityname", () => {
  const xml = condition({ attribute: "name", value: "x", entityalias: "acc" });
  assert.match(xml, /entityname="acc"/);
  assert.match(xml, /attribute="name"/);
  assert.doesNotMatch(xml, /attribute="acc\.name"/);
});

test("condition: un in vide rend un filtre impossible (pas de XML invalide)", () => {
  const xml = condition({ attribute: "statecode", operator: "in", value: [] });
  assert.match(xml, /xsi:nil="true"/);
});

test("fetchXml: document bien formé", () => {
  const xml = fetchXml({
    top: 10,
    entity: { name: "opportunity", attributes: ["name", "sn_number"] },
  });
  assert.match(xml, /^<fetch top="10">/);
  assert.match(xml, /<entity name="opportunity">/);
});

test("filter: un seul enfant n'est pas emballé", () => {
  const xml = filter({ type: "and", conditions: [{ attribute: "statecode", value: 0 }] });
  assert.doesNotMatch(xml!, /<filter/);
});

test("filter: plusieurs enfants sont emballés avec le bon type", () => {
  const xml = filter({
    type: "or",
    conditions: [
      { attribute: "name", value: "a" },
      { attribute: "name", value: "b" },
    ],
  });
  assert.match(xml!, /<filter type="or">/);
});

// ---------------------------------------------------------------------------
// Pagination FetchXML
// ---------------------------------------------------------------------------

test("withTop: ajoute top quand absent (ancien no-op)", () => {
  const out = withTop("<fetch><entity/></fetch>", 500);
  assert.match(out, /<fetch top="500">/);
});

test("withTop: remplace top existant", () => {
  assert.equal(withTop('<fetch top="50"><entity/></fetch>', 200), '<fetch top="200"><entity/></fetch>');
});

test("withPaging: injecte page/count et retire top", () => {
  const out = withPaging('<fetch top="50"><entity/></fetch>', 2, 500, "abc");
  assert.match(out, /page="2"/);
  assert.match(out, /count="500"/);
  assert.match(out, /pagingcookie="abc"/);
  assert.doesNotMatch(out, /top="/);
});

test("withPaging: échappe le pagingcookie", () => {
  const out = withPaging("<fetch><entity/></fetch>", 1, 100, 'a"b');
  assert.match(out, /pagingcookie="a&quot;b"/);
});

// ---------------------------------------------------------------------------
// Vérification d'écriture
// ---------------------------------------------------------------------------

test("verifyWrite: null attendu et champ absent = vérifié (faux positif corrigé)", () => {
  const check = verifyWrite({}, { field: null });
  assert.equal(check.verified, true);
  assert.equal(check.mismatches.length, 0);
});

test("verifyWrite: valeur réellement différente = mismatch", () => {
  const check = verifyWrite({ field: "actual" }, { field: "wanted" });
  assert.equal(check.verified, false);
});

test("verifyWrite: tolérance flottante", () => {
  const check = verifyWrite({ amount: 100.0000001 }, { amount: 100 });
  assert.equal(check.verified, true);
});

test("verifyWrite: ignore les champs @odata.bind et _base", () => {
  const check = verifyWrite({}, { "x@odata.bind": "/opportunities(x)", y_base: 5 });
  assert.equal(check.verified, true);
});

// ---------------------------------------------------------------------------
// Décoration probabilité
// ---------------------------------------------------------------------------

test("probabilityToNumber: '100%' -> 100, nombre inchangé", () => {
  assert.equal(probabilityToNumber("100%"), 100);
  assert.equal(probabilityToNumber(42), 42);
  assert.equal(probabilityToNumber("n/a"), undefined);
});

test("decorateProbability: renomme le champ calculé et expose le numérique", () => {
  const out = decorateProbability({ sn_probability: "80%", closeprobability: 75 });
  assert.equal(out.sn_probability_display, "80%");
  assert.equal(out.close_probability, 75);
  assert.equal("sn_probability" in out, false);
});

// ---------------------------------------------------------------------------
// Sérialisation bornée
// ---------------------------------------------------------------------------

test("serializeResult: compact au-delà du seuil de lignes", () => {
  const big = { records: Array.from({ length: 200 }, (_, i) => ({ i })) };
  const text = serializeResult(big);
  assert.doesNotMatch(text, /\n {2}/); // pas de pretty-print
});

test("serializeResult: borne dure avec enveloppe explicite", () => {
  const huge = { records: Array.from({ length: 5000 }, (_, i) => ({ i, pad: "x".repeat(80) })) };
  const text = serializeResult(huge);
  const parsed = JSON.parse(text);
  assert.equal(parsed.output_truncated, true);
  assert.ok(typeof parsed.preview === "string");
  assert.ok(text.length < 250_000);
});

// ---------------------------------------------------------------------------
// Validation / OData / dates
// ---------------------------------------------------------------------------

test("oneOf: tolère la casse et rejette l'inconnu", () => {
  assert.equal(oneOf("Best_Case", ["best_case", "pipeline"], "f"), "best_case");
  assert.throws(() => oneOf("nope", ["a", "b"], "f"));
});

test("intIn: accepte '30' et applique les bornes", () => {
  assert.equal(intIn("30", "stale_days", { min: 1, max: 365 }), 30);
  assert.throws(() => intIn(0, "n", { min: 1 }));
});

test("entityName: rejette traversée et caractères interdits", () => {
  assert.equal(entityName("opportunities"), "opportunities");
  assert.throws(() => entityName("../WhoAmI"));
  assert.throws(() => assertEntityName("a/b"));
});

test("guid: normalise et rejette un format invalide", () => {
  assert.equal(
    guid("{00000000-0000-0000-0000-000000000000}"),
    "00000000-0000-0000-0000-000000000000"
  );
  assert.throws(() => guid("not-a-guid"));
});

test("normalizeQuarter: accepte les variantes, rejette le reste", () => {
  assert.equal(normalizeQuarter("2026-Q3"), "26-Q3");
  assert.equal(normalizeQuarter("26Q3"), "26-Q3");
  assert.equal(normalizeQuarter("Q3-26"), "26-Q3");
  assert.throws(() => normalizeQuarter("nope"));
});

test("quarterOfDate: déduit le trimestre", () => {
  assert.equal(quarterOfDate("2026-11-03"), "26-Q4");
  assert.equal(currentQuarter(new Date(2026, 0, 15)), "26-Q1");
});

// ---------------------------------------------------------------------------
// Cache LRU
// ---------------------------------------------------------------------------

test("cache: TTL et rafraîchissement", () => {
  cacheSet("k1", "v1", 1000);
  assert.equal(cacheGet("k1"), "v1");
  cacheSet("k2", "v2", -1); // déjà expiré
  assert.equal(cacheGet("k2"), undefined);
});

test("cache: prune retire les expirés sans toucher les valides", () => {
  cacheSet("keep", 1, 1000);
  cacheSet("gone", 2, -1);
  cachePrune();
  assert.equal(cacheGet("keep"), 1);
  assert.equal(cacheGet("gone"), undefined);
});
