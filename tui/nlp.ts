import type { McpTool } from "./types.ts";

/**
 * Interpréteur "langage naturel" — heuristique 100 % locale, sans LLM.
 *
 * Objectif : dans la console (`c`), taper « les opportunités à risque du
 * 26-Q3 » doit suffire à proposer un `tools/call` cohérent, que l'utilisateur
 * relit avant exécution. Ce n'est PAS un LLM : c'est un matching par mots-clés
 * + extraction d'entités (quoted strings, quarters, emails, GUIDs, "top N").
 * Toute proposition est affichée et confirmée — jamais exécutée à l'aveugle.
 */

export interface Guess {
  tool: string;
  args: Record<string, unknown>;
  /** score de confiance du matching (0-1), pour l'afficher. */
  confidence: number;
  /** pourquoi on a choisi cet outil. */
  why: string;
}

const STOP = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "a", "à",
  "pour", "avec", "sur", "dans", "tous", "toutes", "mes", "mon", "ma", "que",
  "qui", "quoi", "donne", "moi", "voir", "liste", "affiche", "show", "get",
  "the", "of", "for", "and", "list", "get", "me", "my", "all", "please",
]);

/** Normalise pour matcher : minuscules, sans accents, séparateurs unifiés. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Découpe normalisée d'une phrase, mots outils et mots trop courts retirés. */
export function tokens(s: string): string[] {
  return normalize(s).split(" ").filter((t) => t.length > 1 && !STOP.has(t));
}

/** Termes-clés associés à chaque outil (nom + description). */
const TOOL_HINTS: Record<string, string[]> = {
  query_records: ["query", "querie", "records", "odata", "fetchxml"],
  get_record: ["record", "guid", "single"],
  create_record: ["creer", "create", "nouveau", "nouvelle"],
  update_record: ["update", "maj", "modifier"],
  delete_record: ["delete", "supprimer", "supprime"],
  get_entity_metadata: ["metadata", "meta", "schema", "structure", "attributs", "champs", "colonnes"],
  list_entities: ["entites", "entities", "tables", "liste"],
  get_my_opportunities: ["opportunites", "opportunities", "pipeline", "mes", "mon pipeline", "ma pipeline"],
  search_opportunities: ["search", "recherche", "chercher", "cherche", "trouve", "retrouve"],
  get_opportunity_products: ["produits", "products", "sku", "lignes", "productlines", "offre"],
  get_collaboration_notes: ["notes", "collaboration", "note"],
  get_specialist_opportunities: ["specialist", "specialiste", "previsions", "prevision"],
  add_opportunity_product: ["ajouter", "produit", "add"],
  add_collaboration_note: ["ajouter", "note"],
  // « synthèse / résumé / par catégorie » marquent le résumé agrégé, tandis que
  // « mes prévisions » renvoie au relevé détaillé du spécialiste.
  get_forecast_summary: ["resume", "resumes", "summary", "synthese", "syntheses", "categorie", "categories", "acv", "agregat", "par categorie"],
  update_opportunity_forecast: ["forecast", "prevision", "categorie", "trimestre", "close"],
  update_specialist_forecast: ["specialist", "specialiste"],
  get_at_risk_deals: ["risque", "at_risk", "at risk", "retard", "stale", "perime", "a risque", "attention"],
};

/**
 * Verbes d'écriture, pondérés plus fort que les simples mots-clés.
 *
 * Sans cette distinction, « crée un enregistrement dans accounts » partait sur
 * `query_records` (le nom d'entité biasait vers l'outil de lecture) alors que
 * l'intention est clairement une mutation. Un verbe d'écriture doit primer.
 */
const MUTATION_VERBS: Record<string, string[]> = {
  create_record: ["cree", "creer", "creation", "nouveau", "nouvelle", "ajoute", "ajouter", "insere", "create", "insert"],
  update_record: ["mets a jour", "met a jour", "modifie", "modifier", "maj", "update", "change", "changer", "corrige", "renomme"],
  delete_record: ["supprime", "supprimer", "efface", "delete", "remove", "suppression"],
  add_opportunity_product: ["ajoute", "ajouter", "add", "ajout", "ajoute un produit", "cree un produit"],
  add_collaboration_note: ["ajoute", "ajouter", "add", "ajout", "note", "ecrit"],
  update_opportunity_forecast: ["mets a jour", "met a jour", "modifie", "modifier", "maj", "update", "change", "changer", "reclasse", "repasse", "forecast"],
  update_specialist_forecast: ["mets a jour", "met a jour", "modifie", "modifier", "maj", "update", "change", "changer", "reclasse", "repasse"],
};

const ENTITY_ALIASES: Record<string, string> = {
  opportunite: "opportunities",
  opportunites: "opportunities",
  opportunities: "opportunities",
  compte: "accounts",
  comptes: "accounts",
  account: "accounts",
  accounts: "accounts",
  contact: "contacts",
  contacts: "contacts",
  produit: "products",
  produits: "products",
  product: "products",
  products: "products",
  activities: "activities",
  tache: "tasks",
  taches: "tasks",
  task: "tasks",
  tasks: "tasks",
  lead: "leads",
  leads: "leads",
  prospect: "leads",
  prospects: "leads",
};
// NB : « entité » n'est volontairement pas un alias d'entité — c'est un mot
// générique qui précède souvent le vrai nom ("l'entité accounts"). Le mettre
// dans la table ferait gagner `entitydefinitions` à tort.

/**
 * Cherche un alias d'entité dans une liste de mots.
 * On tolère le pluriel (« comptes » -> « comptes », « account » -> « accounts »)
 * en essayant aussi le mot sans son « s » final.
 */
function findEntityAlias(words: string[]): string | null {
  for (const w of words) {
    const direct = ENTITY_ALIASES[w];
    if (direct) return direct;
    if (w.endsWith("s")) {
      const singular = ENTITY_ALIASES[w.slice(0, -1)];
      if (singular) return singular;
    }
  }
  return null;
}

export function extractEntities(input: string): string[] {
  const out = new Set<string>();
  // '...' ou "..." -> valeurs explicites
  for (const m of input.matchAll(/['"«]([^'"»]{1,120})['"»]/g)) out.add(m[1].trim());
  // opportunity numbers OPTY1234567
  for (const m of input.matchAll(/\bOPTY\d{4,}\b/gi)) out.add(m[0].toUpperCase());
  // GUIDs
  for (const m of input.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) out.add(m[0]);
  // emails
  for (const m of input.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)) out.add(m[0]);
  // quarters 25-Q3 / 2026-Q1
  for (const m of input.matchAll(/\b(\d{2,4}\s?-?\s?Q[1-4])\b/gi)) out.add(m[1].replace(/\s/g, ""));
  // Nom d'entité explicite : "l'entité accounts", "la table opportunities".
  // On tolère la collocation française (« entité de comptes », « table des
  // comptes ») en autorisant un déterminant intermédiaire.
  for (const m of normalize(input).matchAll(
    /\b(?:entite|entities|table)\s+(?:de\s+|des\s+|du\s+|d\s+)?([a-z_]+)/g
  )) {
    if (!STOP.has(m[1])) out.add(m[1]);
  }
  return [...out].filter(Boolean);
}

/** Verbes d'action usuels : retirés des valeurs extraites (ex. query). */
const ACTION_VERBS = new Set([
  "recherche", "cherche", "chercher", "cherche", "trouve", "trouver", "liste",
  "lister", "affiche", "afficher", "montre", "montrer", "donne", "donner",
  "veux", "veut", "besoin", "peux", "peut", "pourrais", "pourrait", "obtiens",
  "retourne", "fetch", "show", "find", "list", "get", "search", "return",
]);

/** Retire verbes et mots outils d'un texte de requête. */
function stripVerbs(s: string): string {
  return tokens(s).filter((w: string) => !ACTION_VERBS.has(w)).join(" ");
}

function extractTop(input: string): number | null {
  const m = normalize(input).match(/\b(?:top|limite|limit|max)\s*:?=?(\d{1,4})\b/) ??
    normalize(input).match(/\b(\d{1,4})\s+(?:premiers|resultats|elements)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Devine un outil + des arguments à partir d'une phrase. */
export function guessToolCall(input: string, tools: McpTool[]): Guess | null {
  const norm = normalize(input);
  const words = tokens(input);
  const toolNames = new Set(tools.map((t) => t.name));

  // 1) Nom d'outil explicite -> score 1.0
  const explicit = tools.find((t) => norm.includes(normalize(t.name)));
  if (explicit) {
    return {
      tool: explicit.name,
      args: guessArgs(explicit, input),
      confidence: 1,
      why: `nom d'outil explicite "${explicit.name}"`,
    };
  }

  // Un nom d'entité cité ("les comptes", "table opportunities") est un signal
  // fort pour les outils qui prennent un paramètre `entity`.
  const entityAlias = findEntityAlias(words);

  // 2) Scoring par mots-clés
  const wordsSet = new Set(words);
  const scores = tools.map((t) => {
    const hints = TOOL_HINTS[t.name] ?? [];
    let score = 0;
    for (const h of hints) {
      const hn = normalize(h);
      if (norm.includes(hn)) {
        score += hn.includes(" ") ? 2 : 1;
        continue;
      }
      // Accord pluriel / préfixe : "metadonnees" doit matcher "metadata".
      // On compare sur le radical (>= 5 caractères) pour éviter les faux positifs.
      if (hn.length >= 5 && words.some((w: string) => w.length >= 5 && (w.startsWith(hn.slice(0, 5)) || hn.startsWith(w.slice(0, 5))))) {
        score += 0.8;
        continue;
      }
      // Token exact d'un hint dans la phrase ("risque" -> get_at_risk_deals).
      if (!hn.includes(" ") && wordsSet.has(hn)) score += 0.5;
    }
    // Le nom de l'outil lui-même (mots) est un signal fort.
    for (const w of normalize(t.name).split("_")) {
      if (w.length > 2 && wordsSet.has(w)) score += 0.5;
    }
    // Les tokens de la description de l'outil, mais pondérés faiblement.
    for (const w of tokens(t.description ?? "")) {
      if (wordsSet.has(w)) score += 0.15;
    }
    // Outil acceptant `entity` + entité citée dans la phrase.
    if (entityAlias && t.inputSchema?.properties?.entity) score += 1.2;

    // Verbes d'écriture : intention de mutation (prime sur le simple mot-clé).
    for (const v of MUTATION_VERBS[t.name] ?? []) {
      if (norm.includes(normalize(v))) score += 1.8;
    }
    return { tool: t.name, score };
  });
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  if (!best || best.score < 1) return null;

  const tool = tools.find((t) => t.name === best.tool);
  if (!tool || !toolNames.has(best.tool)) return null;
  return {
    tool: best.tool,
    args: guessArgs(tool, input),
    confidence: Math.min(0.95, best.score / 6),
    why: `mots-clés (score ${best.score.toFixed(1)})`,
  };
}

/** Propose des arguments plausibles à partir de la phrase. */
export function guessArgs(tool: McpTool, input: string): Record<string, unknown> {
  const norm = normalize(input);
  const args: Record<string, unknown> = {};
  const schema = tool.inputSchema?.properties ?? {};
  const extracted = extractEntities(input);
  const schemaKeys = Object.keys(schema);

  // 1) quoted strings → premier champ string requis
  const requiredStrings = (tool.inputSchema?.required ?? []).filter(
    (k) => schema[k]?.type === "string"
  );
  if (requiredStrings.length > 0 && extracted.length > 0) {
    const key = requiredStrings[0];
    const value =
      extracted.find((e) => looksLike(schema[key], e)) ?? extracted[0];
    args[key] = coerce(schema[key], value);
  }

  // 2) top/limit
  const top = extractTop(input);
  if (top !== null && schema.top) args.top = top;

  // 3) close_quarter ("26-Q3", "26 Q3", "2026Q3" -> normalisé)
  if (schema.close_quarter) {
    const q = extracted.find((e) => /^\d{2,4}-?Q[1-4]$/i.test(e));
    if (q) args.close_quarter = q;
    else if (/trimestre|quarter|semestre/.test(norm)) args.close_quarter = "(à préciser)";
  }

  // 4) status / role / forecast_category par mots-clés
  const enums: Record<string, string[]> = {
    status: ["open", "won", "lost", "all"],
    forecast_category: ["pipeline", "best_case", "committed", "upside", "closed", "all"],
    role: ["owner", "field_sales_rep", "solution_consultant", "secondary_sales_rep", "renewal_account_manager", "any"],
    note_type: ["Next Steps", "Win/Loss", "General"],
    business_units: ["Security", "Risk", "Impact", "ITSM"],
  };
  for (const [key, values] of Object.entries(enums)) {
    if (!schema[key]) continue;
    const found = values.find((v) => norm.includes(normalize(v)));
    if (found) {
      if (schema[key].type === "array") args[key] = [found];
      else args[key] = found;
    }
  }

  // 5) entity : alias connu dans la phrase, sinon valeur extraite plausible
  if (schema.entity) {
    const alias =
      findEntityAlias(tokens(input)) ??
      extracted.map((e) => ENTITY_ALIASES[normalize(e)] ?? null).find(Boolean);
    if (alias) {
      args.entity = alias;
    } else {
      const guess = extracted.find(
        (e) => !/^\d{2,4}-?Q[1-4]$/i.test(e) && !/@/.test(e) && !/^OPTY/i.test(e)
      );
      if (guess && /^[a-z_]+$/.test(normalize(guess))) args.entity = normalize(guess);
    }
  }

  // 6) opportunity_id / opportunity_number : on ne complète qu'un seul des deux
  const hasOppId = !!schema.opportunity_id;
  const hasOppNum = !!schema.opportunity_number;
  if (hasOppNum) {
    const num = extracted.find((e) => /^OPTY\d+/i.test(e));
    const guid = extracted.find((e) => /^[0-9a-f-]{36}$/i.test(e));
    if (guid) args.opportunity_id = guid;
    if (num) args.opportunity_number = num;
  } else if (hasOppId) {
    const guid = extracted.find((e) => /^[0-9a-f-]{36}$/i.test(e));
    if (guid) args.opportunity_id = guid;
  }

  // 7) query (search_opportunities)
  if (schema.query && args.query === undefined) {
    const explicit = extracted.find(
      (e) => !/^OPTY/i.test(e) && !/^[0-9a-f-]{36}$/i.test(e) && !/@/.test(e)
    );
    // On retire les verbes d'action : "recherche Acme Corp" -> "acme corp".
    const q = explicit ?? stripVerbs(input);
    if (q) args.query = q;
  }

  // 8) email
  if (schema.email) {
    const mail = extracted.find((e) => e.includes("@"));
    if (mail) args.email = mail;
  }

  // 9) booléens
  for (const key of schemaKeys) {
    if (schema[key].type !== "boolean" || args[key] !== undefined) continue;
    const words2 = normalize(input);
    if (key.startsWith("include_")) {
      args[key] = !words2.includes(normalize(key.replace("include_", "sans ")));
    }
  }

  // 10) stale_days : uniquement si la phrase mentionne une durée en jours.
  // On ne comble pas avec une valeur « plausible » — inventer un filtre
  // changerait le sens de la requête ; le champ reste absent et l'utilisateur
  // le remplira dans le formulaire ou en éditant la proposition.
  if (schema.stale_days) {
    const m = norm.match(/(\d{1,3})\s*(?:j|jours?|days?)\b/);
    if (m) args.stale_days = Number(m[1]);
  }

  // 11) truncate les objets aux clés du schéma
  for (const [k, v] of Object.entries(args)) {
    if (!schemaKeys.includes(k)) delete args[k];
    if (typeof v === "string" && v === "(à préciser)") delete args[k];
  }
  return args;
}

function looksLike(schema: unknown, value: string): boolean {
  const s = schema as { type?: string; enum?: unknown[] };
  if (s?.enum) return s.enum.includes(value);
  if (s?.type === "string") return /^[A-Z0-9_-]+$/.test(value) || true;
  return true;
}

/** Convertit une chaîne extraite vers le type déclaré par le JSON schema. */
export function coerce(schema: unknown, raw: string): unknown {
  const s = schema as { type?: string; items?: { type?: string }; enum?: unknown[] };
  if (s?.enum) return raw;
  if (Array.isArray(s?.enum)) return raw;
  switch (s?.type) {
    case "number":
    case "integer": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case "boolean":
      return /^(oui|true|yes|1|vrai)$/i.test(raw);
    case "array":
      return raw.split(",").map((x) => coerce(s.items ?? { type: "string" }, x.trim()));
    case "object":
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    default:
      return raw;
  }
}