/**
 * Constructeurs FetchXML.
 *
 * Tout le FetchXML du serveur est désormais produit par ces builders : plus
 * aucune interpolation manuelle dans les outils. Toutes les valeurs passent
 * par `fetchxmlValue` / `odataString`, ce qui élimine l'injection
 * (`value="x"/><condition …/>`).
 */
import { fetchxmlValue, odataString } from "./odata.js";
// ---------------------------------------------------------------------------
// Briques de base
// ---------------------------------------------------------------------------
/** Attribut `entityname="…"` quand la condition porte sur une entité liée. */
function entityNameAttr(spec) {
    return spec.entityalias ? ` entityname="${fetchxmlValue(spec.entityalias)}"` : "";
}
/** Rend un `<condition …/>`. Toutes les valeurs sont échappées. */
export function condition(spec) {
    const attr = spec.attribute;
    const owner = entityNameAttr(spec);
    const op = spec.operator ?? "eq";
    if (op === "null" || op === "not-null") {
        return `<condition${owner} attribute="${fetchxmlValue(attr)}" operator="${op}" />`;
    }
    if (op === "in" || op === "not-in") {
        const vals = Array.isArray(spec.value) ? spec.value : [spec.value ?? ""];
        if (!vals.length) {
            // Un `in ()` est du FetchXML invalide : on rend un filtre impossible.
            return `<condition${owner} attribute="${fetchxmlValue(attr)}" operator="${op}"><value xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" /></condition>`;
        }
        const inner = vals.map((v) => `<value>${fetchxmlValue(v)}</value>`).join("");
        return `<condition${owner} attribute="${fetchxmlValue(attr)}" operator="${op}">${inner}</condition>`;
    }
    if (op === "like" || op === "not-like") {
        return `<condition${owner} attribute="${fetchxmlValue(attr)}" operator="${op}" value="${fetchxmlValue(`%${String(spec.value ?? "")}%`)}" />`;
    }
    return `<condition${owner} attribute="${fetchxmlValue(attr)}" operator="${op}" value="${fetchxmlValue(spec.value)}" />`;
}
/** Rend un `<filter>` à partir de conditions et/ou de sous-filtres déjà rendus. */
export function filter(spec) {
    if (!spec)
        return undefined;
    if (Array.isArray(spec))
        return renderFilter("and", [], spec);
    const raw = (spec.filters ?? []).filter(Boolean);
    const conditions = spec.conditions ?? [];
    if (!conditions.length && !raw.length)
        return undefined;
    return renderFilter(spec.type ?? "and", conditions, raw);
}
function renderFilter(type, conditions, raw) {
    const parts = [...conditions.map(condition), ...raw.filter(Boolean)];
    if (parts.length === 1 && raw.length === 0) {
        // Un seul enfant : inutile d'emballer, et FetchXML l'accepte.
        return parts[0];
    }
    return `<filter type="${type}">\n        ${parts.join("\n        ")}\n      </filter>`;
}
/** conditions eq guid (raccourci). */
export function eqGuid(attribute, guid, entityalias) {
    return { attribute, operator: "eq", value: guid, entityalias };
}
/** conditions eq string (raccourci). */
export function eqStr(attribute, value, entityalias) {
    return { attribute, operator: "eq", value, entityalias };
}
/** conditions eq entier (raccourci). */
export function eqInt(attribute, value, entityalias) {
    return { attribute, operator: "eq", value, entityalias };
}
/** Rend un `<attribute …/>`. Accepte un nom simple ou une AttributeSpec. */
export function attribute(spec, alias) {
    if (typeof spec === "string") {
        return alias
            ? `<attribute name="${fetchxmlValue(spec)}" alias="${fetchxmlValue(alias)}" />`
            : `<attribute name="${fetchxmlValue(spec)}" />`;
    }
    let xml = `<attribute name="${fetchxmlValue(spec.name)}"`;
    if (spec.alias)
        xml += ` alias="${fetchxmlValue(spec.alias)}"`;
    if (spec.groupby)
        xml += ` groupby="true"`;
    if (spec.aggregate)
        xml += ` aggregate="${fetchxmlValue(spec.aggregate)}"`;
    if (spec.distinct)
        xml += ` distinct="true"`;
    return `${xml} />`;
}
/** Raccourci : attribut agrégé. */
export function aggAttribute(name, fn, alias) {
    return { name, alias, aggregate: fn };
}
/** Raccourci : attribut de groupement. */
export function groupByAttribute(name, alias) {
    return { name, alias, groupby: true };
}
export function linkEntity(spec) {
    const inner = (spec.attributes ?? []).map((a) => attribute(a));
    const f = filter(spec.filter);
    if (f)
        inner.push(f);
    const body = inner.length ? `\n      ${inner.join("\n      ")}\n    ` : "";
    return `<link-entity name="${fetchxmlValue(spec.name)}" from="${fetchxmlValue(spec.from)}" to="${fetchxmlValue(spec.to)}" link-type="${spec.linkType ?? "inner"}" alias="${fetchxmlValue(spec.alias)}">${body}</link-entity>`;
}
function renderEntity(spec) {
    const parts = [];
    const attrs = (spec.attributes ?? []).map((a) => typeof a === "string" ? attribute(a, spec.attributeAliases?.[a]) : attribute(a));
    // Ordre conforme au schéma FetchXML : attribute, order, link-entity, filter.
    if (attrs.length)
        parts.push(attrs.join("\n    "));
    for (const o of spec.order ?? []) {
        parts.push(`<order attribute="${fetchxmlValue(o.attribute)}" descending="${o.descending ? "true" : "false"}" />`);
    }
    for (const link of spec.links ?? [])
        parts.push(linkEntity(link));
    const f = filter(spec.filter);
    if (f)
        parts.push(f);
    const open = `<entity name="${fetchxmlValue(spec.name)}"${spec.alias ? ` alias="${fetchxmlValue(spec.alias)}"` : ""}${spec.distinct ? ' distinct="true"' : ""}${spec.aggregate ? ' aggregate="true"' : ""}>`;
    return `${open}\n    ${parts.join("\n    ")}\n  </entity>`;
}
/** Assemble un document `<fetch>` complet et bien formé. */
export function fetchXml(spec) {
    const attrs = [];
    if (spec.mapping)
        attrs.push(`mapping="${fetchxmlValue(spec.mapping)}"`);
    if (spec.top != null)
        attrs.push(`top="${spec.top}"`);
    if (spec.count)
        attrs.push(`count="${spec.count}"`);
    if (spec.version)
        attrs.push(`version="${fetchxmlValue(spec.version)}"`);
    const open = attrs.length ? `<fetch ${attrs.join(" ")}>` : "<fetch>";
    return `${open}\n  ${renderEntity(spec.entity)}\n</fetch>`;
}
// ---------------------------------------------------------------------------
// Requêtes composites réutilisables
// ---------------------------------------------------------------------------
/** Bloc link-entity vers la BU produit (`sn_productbusinessunit`). */
export function businessUnitLink(businessUnits, { leftOuterWhenNoFilter = true } = {}) {
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
                conditions: businessUnits.map((bu) => eqStr("sn_name", bu)),
            }
            : undefined,
    };
}
/** Bloc link-entity vers l'opportunité, alias `opp`. */
export function opportunityLink(filterSpec, attributes = [
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
]) {
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
export function specialistForecastQuery(o) {
    const oppConditions = [];
    if (o.quarter)
        oppConditions.push(eqStr("sn_closequarter", o.quarter));
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
                opportunityLink(oppConditions.length ? { type: "and", conditions: oppConditions } : undefined, o.opportunityAttributes),
            ],
            order: [{ attribute: "sn_productnnacv", descending: true }],
        },
    });
}
/** Filtre OData `eq` sur une chaîne, utilisé dans les bouts OData. */
export function odataEqStr(attribute, value) {
    return `${attribute} eq ${odataString(value)}`;
}
/** Filtre OData `eq` sur un entier. */
export function odataEqInt(attribute, value) {
    return `${attribute} eq ${Math.trunc(value)}`;
}
// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------
/**
 * Force (ou ajoute) `top="N"` sur l'élément racine `<fetch>`.
 *
 * L'ancienne implémentation faisait `xml.replace(/top="\d+"/, …)` : quand le
 * FetchXML fourni par l'appelant n'avait pas d'attribut `top`, le remplacement
 * était un no-op et la MÊME requête repartait à chaque page — les lignes
 * revenaient en doublon.
 */
export function withTop(xml, top) {
    const value = String(Math.max(1, Math.trunc(top)));
    if (/top="\d+"/.test(xml))
        return xml.replace(/top="\d+"/, `top="${value}"`);
    return xml.replace(/<fetch(\s[^>]*)?>/, (open) => open.replace(/^<fetch/, `<fetch top="${value}"`));
}
/**
 * Injecte les attributs de pagination serveur (`page`, `count`, `pagingcookie`)
 * et retire `top`, qui est incompatible avec le paging par page.
 */
export function withPaging(xml, page, count, cookie) {
    const cleaned = xml
        .replace(/\s(?:page|count|pagingcookie)="[^"]*"/g, "")
        .replace(/\stop="\d+"/g, "");
    const attrs = [
        `page="${Math.max(1, Math.trunc(page))}"`,
        `count="${Math.max(1, Math.trunc(count))}"`,
        cookie ? `pagingcookie="${fetchxmlValue(cookie)}"` : "",
    ]
        .filter(Boolean)
        .join(" ");
    return cleaned.replace(/<fetch(\s[^>]*)?>/, (open) => {
        const base = open.replace(/\s*>$/, "").replace(/\/$/, "");
        return `${base} ${attrs}>`;
    });
}
/**
 * Source unique de la requête utilisée par `get_forecast_summary` et
 * `get_forecast_integrity` (elles étaient dupliquées à 90 %).
 */
export function specialistRowsQuery(o) {
    return (top) => fetchXml({
        top,
        entity: {
            name: "sn_specialistforecast",
            attributes: o.attributes,
            filter: {
                type: "and",
                conditions: [eqGuid("ownerid", o.ownerGuid), eqInt("statecode", 0)],
            },
            links: [
                businessUnitLink(o.businessUnits),
                {
                    name: "opportunity",
                    from: "opportunityid",
                    to: "sn_opportunity",
                    alias: "opp",
                    linkType: "inner",
                    attributes: o.opportunityAttributes,
                    filter: {
                        type: "and",
                        conditions: [
                            eqStr("sn_closequarter", o.quarter),
                            eqInt("statecode", 0),
                            ...(o.extraOpportunityConditions ?? []),
                        ],
                    },
                },
            ],
        },
    });
}
//# sourceMappingURL=fetchxml.js.map