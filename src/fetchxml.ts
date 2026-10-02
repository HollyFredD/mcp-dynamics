/**
 * Constructeurs FetchXML.
 *
 * Tout le FetchXML du serveur est désormais produit par ces builders : plus
 * aucune interpolation manuelle dans les outils. Toutes les valeurs passent
 * par `fetchxmlValue` / `odataString`, ce qui élimine l'injection
 * (`value="x"/><condition …/>`).
 */
import { fetchxmlValue, odataString } from "./odata.js";

export type FetchOperator =
  | "eq"
  | "neq"
  | "gt"
  | "geq"
  | "lt"
  | "leq"
  | "like"
  | "not-like"
  | "in"
  | "not-in"
  | "null"
  | "not-null";

export interface ConditionSpec {
  attribute: string;
  operator?: FetchOperator;
  value?: string | number | boolean | (string | number)[];
  /** Préfixe le nom d'attribut par un alias de link-entity (ex: `opp.sn_number`). */
  entityalias?: string;
}

export interface AttributeSpec {
  /** Logical name of the attribute. Use "*" for an aggregate count-column. */
  name: string;
  /** Alias Dataverse renomme l'attribut dans le résultat (requis pour aggregate/groupby). */
  alias?: string;
  groupby?: boolean;
  aggregate?: string;
  distinct?: boolean;
}

export interface FilterSpec {
  type?: "and" | "or";
  conditions?: ConditionSpec[];
  /** Filtres imbriqués déjà rendus en XML. */
  filters?: string[];
}

export interface LinkEntitySpec {
  name: string;
  from: string;
  to: string;
  alias: string;
  linkType?: "inner" | "left-outer";
  attributes?: Array<string | AttributeSpec>;
  filter?: FilterSpec;
}

export interface EntitySpec {
  name: string;
  alias?: string;
  attributes?: Array<string | AttributeSpec>;
  /** Aliases d'attribut : nom -> libellé renvoyé par Dataverse. */
  attributeAliases?: Record<string, string>;
  filter?: FilterSpec;
  links?: LinkEntitySpec[];
  order?: { attribute: string; descending?: boolean }[];
  top?: number;
  distinct?: boolean;
  aggregate?: boolean;
  /** Attributs de groupement (agrégation FetchXML). */
  groupBy?: string[];
}

export interface FetchSpec {
  mapping?: string;
  version?: string;
  top?: number;
  count?: number;
  entity: EntitySpec;
}

// ---------------------------------------------------------------------------
// Briques de base
// ---------------------------------------------------------------------------

function attrName(spec: { attribute: string; entityalias?: string }): string {
  return spec.entityalias ? `${spec.entityalias}.${spec.attribute}` : spec.attribute;
}

/** Rend un `<condition …/>`. Toutes les valeurs sont échappées. */
export function condition(spec: ConditionSpec): string {
  const attr = attrName(spec);
  const op: FetchOperator = spec.operator ?? "eq";

  if (op === "null" || op === "not-null") {
    return `<condition attribute="${fetchxmlValue(attr)}" operator="${op}" />`;
  }

  if (op === "in" || op === "not-in") {
    const vals = Array.isArray(spec.value) ? spec.value : [spec.value ?? ""];
    if (!vals.length) {
      // Un `in ()` est du FetchXML invalide : on rend un filtre impossible.
      return `<condition attribute="${fetchxmlValue(attr)}" operator="${op}"><value xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" /></condition>`;
    }
    const inner = vals.map((v) => `<value>${fetchxmlValue(v as string | number)}</value>`).join("");
    return `<condition attribute="${fetchxmlValue(attr)}" operator="${op}">${inner}</condition>`;
  }

  if (op === "like" || op === "not-like") {
    return `<condition attribute="${fetchxmlValue(attr)}" operator="${op}" value="${fetchxmlValue(
      `%${String(spec.value ?? "")}%`
    )}" />`;
  }

  return `<condition attribute="${fetchxmlValue(attr)}" operator="${op}" value="${fetchxmlValue(
    spec.value as string | number
  )}" />`;
}

/** Rend un `<filter>` à partir de conditions et/ou de sous-filtres déjà rendus. */
export function filter(spec: FilterSpec | string[] | undefined): string | undefined {
  if (!spec) return undefined;
  if (Array.isArray(spec)) return renderFilter("and", [], spec as string[]);
  const children: string[] = [...(spec.conditions ?? []).map(condition)];
  if (spec.filters?.length) children.push(...spec.filters.filter(Boolean));
  if (!children.length) return undefined;
  return renderFilter(spec.type ?? "and", [], children);
}

function renderFilter(type: "and" | "or", conditions: ConditionSpec[], raw: string[]): string {
  const parts = [...conditions.map(condition), ...raw.filter(Boolean)];
  if (parts.length === 1 && raw.length === 0) {
    // Un seul enfant : inutile d'emballer, et FetchXML l'accepte.
    return parts[0];
  }
  return `<filter type="${type}">\n        ${parts.join("\n        ")}\n      </filter>`;
}

/** conditions eq guid (raccourci). */
export function eqGuid(attribute: string, guid: string, entityalias?: string): ConditionSpec {
  return { attribute, operator: "eq", value: guid, entityalias };
}
/** conditions eq string (raccourci). */
export function eqStr(attribute: string, value: string, entityalias?: string): ConditionSpec {
  return { attribute, operator: "eq", value, entityalias };
}
/** conditions eq entier (raccourci). */
export function eqInt(attribute: string, value: number, entityalias?: string): ConditionSpec {
  return { attribute, operator: "eq", value, entityalias };
}

/** Rend un `<attribute …/>`. Accepte un nom simple ou une AttributeSpec. */
export function attribute(spec: string | AttributeSpec, alias?: string): string {
  if (typeof spec === "string") {
    return alias
      ? `<attribute name="${fetchxmlValue(spec)}" alias="${fetchxmlValue(alias)}" />`
      : `<attribute name="${fetchxmlValue(spec)}" />`;
  }
  let xml = `<attribute name="${fetchxmlValue(spec.name)}"`;
  if (spec.alias) xml += ` alias="${fetchxmlValue(spec.alias)}"`;
  if (spec.groupby) xml += ` groupby="true"`;
  if (spec.aggregate) xml += ` aggregate="${fetchxmlValue(spec.aggregate)}"`;
  if (spec.distinct) xml += ` distinct="true"`;
  return `${xml} />`;
}

/** Raccourci : attribut agrégé. */
export function aggAttribute(
  name: string,
  fn: "sum" | "avg" | "min" | "max" | "count" | "countcolumn",
  alias: string
): AttributeSpec {
  return { name, alias, aggregate: fn };
}

/** Raccourci : attribut de groupement. */
export function groupByAttribute(name: string, alias: string): AttributeSpec {
  return { name, alias, groupby: true };
}

export function linkEntity(spec: LinkEntitySpec): string {
  const inner: string[] = (spec.attributes ?? []).map((a) => attribute(a));
  const f = filter(spec.filter);
  if (f) inner.push(f);
  const body = inner.length ? `\n      ${inner.join("\n      ")}\n    ` : "";
  return `<link-entity name="${fetchxmlValue(spec.name)}" from="${fetchxmlValue(
    spec.from
  )}" to="${fetchxmlValue(spec.to)}" link-type="${spec.linkType ?? "inner"}" alias="${fetchxmlValue(
    spec.alias
  )}">${body}</link-entity>`;
}

function renderEntity(spec: EntitySpec): string {
  const parts: string[] = [];
  const attrs = (spec.attributes ?? []).map((a) =>
    typeof a === "string" ? attribute(a, spec.attributeAliases?.[a]) : attribute(a)
  );
  // Ordre conforme au schéma FetchXML : attribute, order, link-entity, filter.
  if (attrs.length) parts.push(attrs.join("\n    "));

  for (const o of spec.order ?? []) {
    parts.push(
      `<order attribute="${fetchxmlValue(
        o.attribute
      )}" descending="${o.descending ? "true" : "false"}" />`
    );
  }

  for (const link of spec.links ?? []) parts.push(linkEntity(link));

  const f = filter(spec.filter);
  if (f) parts.push(f);

  const open = `<entity name="${fetchxmlValue(spec.name)}"${
    spec.alias ? ` alias="${fetchxmlValue(spec.alias)}"` : ""
  }${spec.distinct ? ' distinct="true"' : ""}${spec.aggregate ? ' aggregate="true"' : ""}>`;
  return `${open}\n    ${parts.join("\n    ")}\n  </entity>`;
}

/** Assemble un document `<fetch>` complet et bien formé. */
export function fetchXml(spec: FetchSpec): string {
  const attrs: string[] = [];
  if (spec.mapping) attrs.push(`mapping="${fetchxmlValue(spec.mapping)}"`);
  if (spec.top != null) attrs.push(`top="${spec.top}"`);
  if (spec.count) attrs.push(`count="${spec.count}"`);
  if (spec.version) attrs.push(`version="${fetchxmlValue(spec.version)}"`);
  const open = attrs.length ? `<fetch ${attrs.join(" ")}>` : "<fetch>";
  return `${open}\n  ${renderEntity(spec.entity)}\n</fetch>`;
}

// ---------------------------------------------------------------------------
// Requêtes composites réutilisables
// ---------------------------------------------------------------------------

/** Bloc link-entity vers la BU produit (`sn_productbusinessunit`). */
export function businessUnitLink(
  businessUnits: string[] | undefined,
  { leftOuterWhenNoFilter = true }: { leftOuterWhenNoFilter?: boolean } = {}
): LinkEntitySpec {
  const has = businessUnits && businessUnits.length > 0;
  return {
    name: "sn_productbusinessunit",
    from: "sn_productbusinessunitid",
    to: "sn_businessunit",
    alias: "bu",
    linkType: has ? "inner" : leftOuterWhenNoFilter ? "left-outer" : "inner",
    attributes: ["sn_name"],
    filter: has
      ? {
          type: "or",
          conditions: businessUnits!.map((bu) => eqStr("sn_name", bu)),
        }
      : undefined,
  };
}

/** Bloc link-entity vers l'opportunité, alias `opp`. */
export function opportunityLink(
  filterSpec?: FilterSpec,
  attributes: string[] = [
    "name",
    "sn_number",
    "sn_closequarter",
    "sn_salesstage",
    "sn_forecastcategory",
    "sn_netnewacv",
    "sn_totalvalue",
    "statecode",
    "estimatedclosedate",
    "sn_probability",
  ]
): LinkEntitySpec {
  return {
    name: "opportunity",
    from: "opportunityid",
    to: "sn_opportunity",
    alias: "opp",
    linkType: "inner",
    attributes,
    filter: filterSpec,
  };
}

/**
 * Requête de base sur `sn_specialistforecast` : propriétaire + BU + opportunité.
 * Réutilisée par get_specialist_opportunities, get_forecast_summary,
 * get_at_risk / integrity / team rollup.
 */
export interface SpecialistQueryOpts {
  ownerGuid: string;
  businessUnits?: string[];
  quarter?: string;
  /** Filtre sur statecode de l'opportunité. Défaut : ouvert (0). */
  opportunityStateCode?: number | null;
  top?: number;
  extraOpportunityConditions?: ConditionSpec[];
  attributes?: string[];
  opportunityAttributes?: string[];
}

export function specialistForecastQuery(o: SpecialistQueryOpts): string {
  const oppConditions: ConditionSpec[] = [];
  if (o.quarter) oppConditions.push(eqStr("sn_closequarter", o.quarter));
  if (o.opportunityStateCode != null) {
    oppConditions.push(eqInt("statecode", o.opportunityStateCode));
  }
  oppConditions.push(...(o.extraOpportunityConditions ?? []));

  return fetchXml({
    top: o.top,
    entity: {
      name: "sn_specialistforecast",
      attributes: o.attributes ?? [
        "sn_specialistforecastid",
        "sn_forecasttype",
        "sn_specialistforecastcategory",
        "sn_specialistforecastcategoryreporting",
        "sn_productnnacv",
        "sn_specialistnnacvreporting",
        "statecode",
      ],
      filter: {
        type: "and",
        conditions: [
          { attribute: "ownerid", operator: "eq", value: o.ownerGuid },
          { attribute: "statecode", operator: "eq", value: 0 },
        ],
      },
      links: [
        businessUnitLink(o.businessUnits),
        opportunityLink(
          oppConditions.length ? { type: "and", conditions: oppConditions } : undefined,
          o.opportunityAttributes
        ),
      ],
      order: [{ attribute: "sn_productnnacv", descending: true }],
    },
  });
}

/** Filtre OData `eq` sur une chaîne, utilisé dans les bouts OData. */
export function odataEqStr(attribute: string, value: string): string {
  return `${attribute} eq ${odataString(value)}`;
}
/** Filtre OData `eq` sur un entier. */
export function odataEqInt(attribute: string, value: number): string {
  return `${attribute} eq ${Math.trunc(value)}`;
}