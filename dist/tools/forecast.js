import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { queryRecords, queryAllFetchXml, updateRecord, getRecord, resolveUserGuid, assertEntityWritable, } from "../dataverse.js";
import { odataString } from "../odata.js";
import { fetchXml, eqInt, eqStr, eqGuid, filter as renderFilter, businessUnitLink, specialistForecastQuery, aggAttribute, groupByAttribute, } from "../fetchxml.js";
import { FORECAST_CODES, FORECAST_WRITABLE, CATEGORY_LABELS, AT_RISK, STATE_OPEN, ROLE_FIELDS_FETCHXML, CLOSE_PROBABILITY_FIELD, SN_PROBABILITY_FIELD, } from "../constants.js";
import { CLOSURE_BLOCKERS, BLOCKER_LABELS, CHECKLIST_GROUPS, allChecklistFields } from "../checklist.js";
import { bool, intIn, oneOf, str, strArray } from "../validate.js";
import { civilDate, civilDateAddDays, quarterContext } from "../dates.js";
import { buildDiff, logMutation, maybeQuarter, requireQuarter, resolveOpportunityId, verifyWrite, } from "./common.js";
import { probabilityToNumber } from "./opportunities.js";
/** Entités que ce module a le droit d'écrire via un outil métier dédié. */
const SANCTIONED_SF_WRITES = ["sn_specialistforecasts"];
const DRY_RUN_PROP = {
    dry_run: {
        type: "boolean",
        description: "When true (DEFAULT) nothing is written: the tool returns the exact diff it WOULD apply. Set false to actually write.",
    },
};
// ===========================================================================
// get_specialist_opportunities
// ===========================================================================
const getSpecialistOpportunitiesTool = {
    name: "get_specialist_opportunities",
    description: "Get sn_specialistforecast records for a specialist, filtered by BU, quarter and status. By default only OPEN opportunities are returned (statecode eq 0) so figures match get_forecast_summary. This is NOT the product-line list — use get_opportunity_products for that. Pass status='all' to include won/lost.",
    inputSchema: {
        type: "object",
        properties: {
            email: { type: "string", description: "Specialist email (defaults to authenticated user)" },
            business_units: {
                type: "array",
                items: { type: "string" },
                description: "BU names, e.g. ['Security','Risk','Impact']. Empty = all BUs.",
            },
            close_quarter: { type: "string", description: "Close quarter, e.g. '26-Q2' or '2026-Q3'" },
            status: {
                type: "string",
                enum: ["open", "won", "lost", "all"],
                description: "Opportunity status (default: 'open' — matches get_forecast_summary)",
            },
            top: { type: "number", description: "Maximum records (default 100, max 1000)" },
            fetch_all: { type: "boolean", description: "Follow pagination (default false)" },
        },
    },
};
const STATUS_CODE_BY_NAME = { open: 0, won: 1, lost: 2 };
async function handleGetSpecialistOpportunities(args) {
    const email = str(args.email, "email", { max: 200 });
    const businessUnits = strArray(args.business_units, "business_units", { max: 100, maxItems: 25 });
    const quarter = maybeQuarter(args.close_quarter);
    const status = oneOf(args.status, ["open", "won", "lost", "all"], "status", "open");
    const top = intIn(args.top, "top", { def: 100, min: 1, max: 1000 });
    const fetchAll = bool(args.fetch_all, "fetch_all", false);
    const userGuid = await resolveUserGuid(email);
    const opportunityStateCode = status && status !== "all" ? STATUS_CODE_BY_NAME[status] : null;
    const build = (fetchTop) => specialistForecastQuery({
        ownerGuid: userGuid,
        businessUnits,
        quarter,
        opportunityStateCode,
        top: fetchTop,
    });
    const res = fetchAll
        ? await queryAllFetchXml({
            entity: "sn_specialistforecasts",
            buildFetch: build,
            page_size: top,
            max_pages: 10,
        })
        : await (async () => {
            const one = await queryRecords({ entity: "sn_specialistforecasts", fetchxml: build(top) });
            return {
                value: one.value,
                truncated: one.value.length >= top,
                has_more: one.value.length >= top,
            };
        })();
    const rows = res.value.map(decorateSpecialist);
    return {
        filters: {
            email: email ?? "<authenticated user>",
            owner_id: userGuid,
            business_units: businessUnits ?? "all",
            close_quarter: quarter ?? null,
            status: status ?? "open",
            note: status === "all"
                ? "status='all' includes won/lost opportunities: figures will NOT match get_forecast_summary (which is open-only)."
                : undefined,
        },
        row_count: rows.length,
        total_records: rows.length,
        truncated: res.truncated,
        has_more: res.has_more,
        total_acv: rows.reduce((sum, r) => sum + (r.specialist_nnacv ?? 0), 0),
        specialist_forecasts: rows,
    };
}
function decorateSpecialist(row) {
    const out = { ...row };
    const display = row[SN_PROBABILITY_FIELD];
    if (display !== undefined) {
        out.sn_probability_display = display;
        delete out[SN_PROBABILITY_FIELD];
    }
    out.close_probability = probabilityToNumber(display) ?? null;
    const oppCat = row["opp.sn_forecastcategory"];
    if (typeof oppCat === "number") {
        out.opportunity_forecast_category = CATEGORY_LABELS[oppCat] ?? `unknown_${oppCat}`;
    }
    const cat = row.sn_specialistforecastcategory;
    if (typeof cat === "number") {
        out.specialist_forecast_category = CATEGORY_LABELS[cat] ?? `unknown_${cat}`;
    }
    out.specialist_nnacv = row.sn_productnnacv ?? 0;
    return out;
}
// ===========================================================================
// get_forecast_summary
// ===========================================================================
const getForecastSummaryTool = {
    name: "get_forecast_summary",
    description: "Aggregated forecast summary for a specialist by quarter: total ACV and deal count per forecast category and per business unit. Reads ALL rows (pagination is followed), so totals are never silently capped. Reports total_records (LINES) vs distinct_deals (unique opportunities) plus unknown_categories and truncated.",
    inputSchema: {
        type: "object",
        properties: {
            close_quarter: {
                type: "string",
                description: "Quarter to summarize, e.g. '26-Q2' (any accepted format)",
            },
            email: { type: "string", description: "Specialist email (defaults to authenticated user)" },
            business_units: {
                type: "array",
                items: { type: "string" },
                description: "Filter by BU names, e.g. ['Security','Risk']",
            },
        },
        required: ["close_quarter"],
    },
};
async function handleGetForecastSummary(args) {
    const quarter = requireQuarter(args.close_quarter);
    const email = str(args.email, "email", { max: 200 });
    const businessUnits = strArray(args.business_units, "business_units", { max: 100, maxItems: 25 });
    const userGuid = await resolveUserGuid(email);
    const build = (top) => fetchXml({
        top,
        entity: {
            name: "sn_specialistforecast",
            attributes: [
                "sn_specialistforecastid",
                "sn_specialistforecastcategory",
                "sn_specialistforecastcategoryreporting",
                "sn_productnnacv",
                "sn_specialistnnacvreporting",
            ],
            filter: {
                type: "and",
                conditions: [eqGuid("ownerid", userGuid), eqInt("statecode", STATE_OPEN)],
            },
            links: [
                businessUnitLink(businessUnits),
                {
                    name: "opportunity",
                    from: "opportunityid",
                    to: "sn_opportunity",
                    alias: "opp",
                    linkType: "inner",
                    attributes: ["name", "sn_number", "sn_closequarter", "estimatedclosedate", "sn_salesstage"],
                    filter: {
                        type: "and",
                        conditions: [eqStr("sn_closequarter", quarter), eqInt("statecode", STATE_OPEN)],
                    },
                },
            ],
        },
    });
    const res = await queryAllFetchXml({
        entity: "sn_specialistforecasts",
        buildFetch: build,
        page_size: 500,
        max_pages: 20,
    });
    const byCategory = {};
    const byBU = {};
    const unknownCategories = new Set();
    const allDeals = new Set();
    let totalACV = 0;
    for (const row of res.value) {
        const code = row.sn_specialistforecastcategory;
        const cat = typeof code === "number"
            ? CATEGORY_LABELS[code] ?? `unknown_${code}`
            : "unknown_undefined";
        if (cat.startsWith("unknown_"))
            unknownCategories.add(cat);
        const acv = row.sn_productnnacv ?? 0;
        const oppNumber = row["opp.sn_number"] ?? "";
        const bu = row["bu.sn_name"] ?? "Unknown";
        if (!byCategory[cat])
            byCategory[cat] = { acv: 0, records: 0, deals: 0, dealList: [] };
        byCategory[cat].acv += acv;
        byCategory[cat].records += 1;
        if (oppNumber) {
            allDeals.add(oppNumber);
            if (!byCategory[cat].dealList.includes(oppNumber)) {
                byCategory[cat].dealList.push(oppNumber);
                byCategory[cat].deals += 1;
            }
        }
        if (!byBU[bu])
            byBU[bu] = {};
        if (!byBU[bu][cat])
            byBU[bu][cat] = { acv: 0, records: 0 };
        byBU[bu][cat].acv += acv;
        byBU[bu][cat].records += 1;
        totalACV += acv;
    }
    const context = quarterContext(quarter);
    return {
        quarter,
        total_acv: totalACV,
        // H12 : total_records = LIGNES, distinct_deals = deals uniques. Les deux
        // chiffres sont explicites pour éviter les contradictions annoncées.
        total_records: res.value.length,
        distinct_deals: allDeals.size,
        by_category: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [
            k,
            { acv: v.acv, records: v.records, deals: v.deals, opportunities: v.dealList },
        ])),
        by_business_unit: byBU,
        unknown_categories: [...unknownCategories],
        truncated: res.truncated,
        has_more: res.has_more,
        pages_fetched: res.pages,
        totals_are_exact: !res.truncated,
        quarter_context: {
            start_date: context.start_date,
            end_date: context.end_date,
            is_past: context.is_past,
            is_current: context.is_current,
            days_remaining: context.days_remaining,
        },
        warning: unknownCategories.size
            ? `Unrecognised forecast category code(s): ${[...unknownCategories].join(", ")}. Call list_picklist_values(entity='sn_specialistforecasts', attribute='sn_specialistforecastcategory') to decode them.`
            : undefined,
    };
}
// ===========================================================================
// update_specialist_forecast
// ===========================================================================
const updateSpecialistForecastTool = {
    name: "update_specialist_forecast",
    description: "Update the forecast category on a specialist forecast record (sn_specialistforecast). DRY RUN by default. If more than one candidate row matches (several BUs) the call is REFUSED with the list of business units — pass business_unit to disambiguate, or confirm=true to update all of them.",
    inputSchema: {
        type: "object",
        properties: {
            opportunity_id: {
                type: "string",
                description: "GUID of the opportunity (use this or opportunity_number)",
            },
            opportunity_number: {
                type: "string",
                description: "Opportunity number like 'OPTY5331870'",
            },
            forecast_category: {
                type: "string",
                enum: FORECAST_WRITABLE,
                description: "New forecast category for the specialist forecast record",
            },
            business_unit: {
                type: "string",
                description: "BU name to disambiguate when several specialist forecasts exist, e.g. 'Security'",
            },
            email: { type: "string", description: "Specialist email (defaults to authenticated user)" },
            confirm: {
                type: "boolean",
                description: "Required to update MORE THAN ONE business unit at a time. Without it, ambiguous matches are refused.",
            },
            ...DRY_RUN_PROP,
        },
        required: ["forecast_category"],
    },
};
async function handleUpdateSpecialistForecast(args) {
    // Seuls cet outil et ses dry-run touches sn_specialistforecasts : il est
    // explicitement « sanctionné » ici, hors de la WRITE_ALLOWLIST générique.
    assertEntityWritable("sn_specialistforecasts", SANCTIONED_SF_WRITES);
    const opp = await resolveOpportunityId(str(args.opportunity_id, "opportunity_id"), str(args.opportunity_number, "opportunity_number"));
    const forecastCategory = oneOf(args.forecast_category, FORECAST_WRITABLE, "forecast_category");
    const businessUnit = str(args.business_unit, "business_unit", { max: 200 });
    const email = str(args.email, "email", { max: 200 });
    const confirm = bool(args.confirm, "confirm", false);
    const dryRun = bool(args.dry_run, "dry_run", true) ?? true;
    const userGuid = await resolveUserGuid(email);
    const build = (top) => fetchXml({
        top,
        entity: {
            name: "sn_specialistforecast",
            attributes: ["sn_specialistforecastid", "sn_specialistforecastcategory", "sn_productnnacv"],
            filter: {
                type: "and",
                conditions: [
                    eqGuid("ownerid", userGuid),
                    eqGuid("sn_opportunity", opp.id),
                    eqInt("statecode", STATE_OPEN),
                ],
            },
            links: [
                businessUnitLink(businessUnit ? [businessUnit] : undefined),
            ],
        },
    });
    const sfRecords = await queryAllFetchXml({
        entity: "sn_specialistforecasts",
        buildFetch: build,
        page_size: 25,
        max_pages: 4,
    });
    if (!sfRecords.value.length) {
        throw new McpError(ErrorCode.InvalidParams, `No specialist forecast found for opportunity ${opp.number ?? opp.id}${businessUnit ? ` / BU '${businessUnit}'` : ""}. Either you do not own it, the opportunity has no specialist forecast line, or the BU name does not match. Call get_specialist_opportunities(email=<yours>, business_units=['${businessUnit ?? "Security"}']) to inspect what exists.`);
    }
    const candidates = sfRecords.value;
    const bus = candidates.map((r) => r["bu.sn_name"] ?? "Unknown");
    /** Correspondance stricte BU demandée -> nom du match, pour le diff. */
    const newCode = FORECAST_CODES[forecastCategory];
    if (candidates.length > 1 && confirm !== true) {
        throw new McpError(ErrorCode.InvalidParams, `Ambiguous: ${candidates.length} specialist forecast records match opportunity ${opp.number ?? opp.id} (business units: ${bus.join(", ")}). Re-call with business_unit='<one of these>' to target a single BU, or confirm=true to update all ${candidates.length} records.`);
    }
    const before = await Promise.all(candidates.map((c) => getRecord("sn_specialistforecasts", String(c.sn_specialistforecastid), [
        "sn_specialistforecastid",
        "sn_specialistforecastcategory",
    ])));
    const diff = candidates.map((_c, i) => buildDiff(before[i], { sn_specialistforecastcategory: newCode })[0]);
    if (dryRun) {
        return {
            dry_run: true,
            opportunity_id: opp.id,
            opportunity_number: opp.number ?? null,
            would_update: candidates.length,
            business_units: bus,
            diff,
            next_step: "Call again with dry_run=false to apply.",
        };
    }
    // H17 : relire après écriture et vérifier, plutôt qu'annoncer un succès aveugle.
    const results = [];
    await Promise.all(candidates.map(async (c, i) => {
        const sfId = String(c.sn_specialistforecastid).toLowerCase();
        await updateRecord("sn_specialistforecasts", sfId, { sn_specialistforecastcategory: newCode }, ["sn_specialistforecastcategory"]);
        const reread = await getRecord("sn_specialistforecasts", sfId, [
            "sn_specialistforecastcategory",
        ]).catch(() => undefined);
        const check = verifyWrite(reread ?? {}, { sn_specialistforecastcategory: newCode });
        results.push({
            id: sfId,
            bu: bus[i],
            from: before[i]?.sn_specialistforecastcategory,
            to: newCode,
            verified: check.verified,
            reread,
        });
    }));
    logMutation("update_specialist_forecast", {
        opportunity: opp.number ?? opp.id,
        category: forecastCategory,
        rows: results.length,
    });
    return {
        dry_run: false,
        message: `Updated ${results.length} specialist forecast record(s) to '${forecastCategory}'`,
        updated: results,
        verified: results.every((r) => r.verified),
        warning: results.every((r) => r.verified)
            ? undefined
            : "Some rows could not be verified after writing (field may be read-only).",
    };
}
// ===========================================================================
// get_at_risk_deals
// ===========================================================================
const getAtRiskDealsTool = {
    name: "get_at_risk_deals",
    description: "Open deals needing attention before a forecast call: overdue (close date before today, local civil date), stale (not modified in X days), or misaligned (committed/best_case with closeprobability below 30%). Covers all five roles including renewal_account_manager. Probability filtering uses the NUMERIC closeprobability field — sn_probability is calculated and cannot be filtered.",
    inputSchema: {
        type: "object",
        properties: {
            email: { type: "string", description: "User email (defaults to authenticated user)" },
            close_quarter: { type: "string", description: "Restrict to a close quarter, e.g. '26-Q2'" },
            stale_days: {
                type: "number",
                description: "Flag deals not modified in this many days (default 30, allowed 1-365)",
            },
            include_overdue: { type: "boolean", description: "Include deals with a past close date (default true)" },
            include_stale: { type: "boolean", description: "Include deals not updated recently (default true)" },
            include_misaligned: {
                type: "boolean",
                description: "Include committed/best_case deals with closeprobability < 30 (default true)",
            },
        },
    },
};
async function handleGetAtRiskDeals(args) {
    const email = str(args.email, "email", { max: 200 });
    const quarter = maybeQuarter(args.close_quarter);
    const staleDays = intIn(args.stale_days, "stale_days", {
        def: AT_RISK.staleDaysDefault,
        min: AT_RISK.staleDaysMin,
        max: AT_RISK.staleDaysMax,
    });
    const includeOverdue = bool(args.include_overdue, "include_overdue", true) ?? true;
    const includeStale = bool(args.include_stale, "include_stale", true) ?? true;
    const includeMisaligned = bool(args.include_misaligned, "include_misaligned", true) ?? true;
    const userGuid = await resolveUserGuid(email);
    // H6 : date civile LOCALE, et « en retard » = avant DEMAIN (donc le jour même
    // est inclus comme « à surveiller », pas « en retard »).
    const today = civilDate();
    const tomorrow = civilDateAddDays(1);
    const staleThreshold = civilDateAddDays(-staleDays);
    const baseSelect = [
        "opportunityid",
        "name",
        "sn_number",
        "estimatedclosedate",
        "sn_forecastcategory",
        "sn_netnewacv",
        "sn_salesstage",
        "sn_closequarter",
        "modifiedon",
        CLOSE_PROBABILITY_FIELD,
        SN_PROBABILITY_FIELD,
    ];
    // H9 : les CINQ rôles, table unique partagée avec get_my_opportunities.
    const roleConditions = Object.values(ROLE_FIELDS_FETCHXML).map((attr) => eqGuid(attr, userGuid));
    const quarterCond = quarter ? [eqStr("sn_closequarter", quarter)] : [];
    // Le roleOr doit être un « or » à l'intérieur du même « and » : on rend le
    // sous-filtre via le builder plutôt que d'écrire un link-entity trompeur.
    const buildQuery = (extra, orderAttribute, descending = false) => (top) => fetchXml({
        top,
        entity: {
            name: "opportunity",
            attributes: baseSelect,
            filter: {
                type: "and",
                conditions: [eqInt("statecode", STATE_OPEN), ...extra, ...quarterCond],
                filters: [renderRoleOr(roleConditions)],
            },
            order: [{ attribute: orderAttribute, descending }],
        },
    });
    const atRisk = {};
    const truncatedFlags = {};
    const run = async (key, extra, orderAttribute, descending = false) => {
        const res = await queryAllFetchXml({
            entity: "opportunities",
            buildFetch: buildQuery(extra, orderAttribute, descending),
            page_size: 200,
            max_pages: 5,
        });
        atRisk[key] = res.value.map(decorateOpportunityLight);
        truncatedFlags[key] = res.truncated;
    };
    // T3 : les trois requêtes sont indépendantes -> Promise.all.
    const tasks = [];
    if (includeOverdue) {
        tasks.push(run("overdue", [{ attribute: "estimatedclosedate", operator: "lt", value: tomorrow }], "estimatedclosedate"));
    }
    if (includeStale) {
        tasks.push(run("stale", [{ attribute: "modifiedon", operator: "lt", value: staleThreshold }], "modifiedon"));
    }
    if (includeMisaligned) {
        tasks.push(run("misaligned_category", [
            { attribute: CLOSE_PROBABILITY_FIELD, operator: "lt", value: AT_RISK.misalignedProbability },
            {
                attribute: "sn_forecastcategory",
                operator: "in",
                value: AT_RISK.committedCategories,
            },
        ], "sn_netnewacv", true));
    }
    await Promise.all(tasks);
    // LOW : total_issues comptait les CATÉGORIES, pas les deals.
    const distinctDeals = new Set();
    let totalIssues = 0;
    for (const arr of Object.values(atRisk)) {
        totalIssues += arr.length;
        for (const r of arr) {
            if (r.sn_number)
                distinctDeals.add(String(r.sn_number));
        }
    }
    return {
        checked_on: today,
        timezone_note: "Dates are LOCAL civil dates; 'overdue' means a close date strictly before tomorrow, so a deal closing today is not flagged as overdue.",
        stale_threshold_days: staleDays,
        stale_threshold_date: staleThreshold,
        filters: {
            email: email ?? "<authenticated user>",
            close_quarter: quarter ?? null,
            roles_checked: Object.values(ROLE_FIELDS_FETCHXML),
        },
        total_issues: totalIssues,
        distinct_deals: distinctDeals.size,
        at_risk: atRisk,
        truncated: Object.values(truncatedFlags).some(Boolean),
    };
}
function renderRoleOr(conditions) {
    return renderFilter({ type: "or", conditions }) ?? "";
}
function decorateOpportunityLight(row) {
    const out = { ...row };
    const display = row[SN_PROBABILITY_FIELD];
    if (display !== undefined) {
        out.sn_probability_display = display;
        delete out[SN_PROBABILITY_FIELD];
    }
    out.close_probability = row[CLOSE_PROBABILITY_FIELD] ?? probabilityToNumber(display) ?? null;
    const cat = row.sn_forecastcategory;
    if (typeof cat === "number")
        out.forecast_category = CATEGORY_LABELS[cat] ?? `unknown_${cat}`;
    return out;
}
// ===========================================================================
// get_forecast_integrity (F3)
// ===========================================================================
const getForecastIntegrityTool = {
    name: "get_forecast_integrity",
    description: "Forecast call quality control: compares the operational columns of sn_specialistforecast against the reporting columns (sn_specialistforecastcategory vs sn_specialistforecastcategoryreporting, sn_productnnacv vs sn_specialistnnacvreporting) and returns every mismatch with its ACV delta. A non-empty mismatches array means the operational and reporting views of the forecast have diverged.",
    inputSchema: {
        type: "object",
        properties: {
            close_quarter: { type: "string", description: "Quarter to audit, e.g. '26-Q3'" },
            email: { type: "string", description: "Specialist email (defaults to authenticated user)" },
            business_units: {
                type: "array",
                items: { type: "string" },
                description: "Restrict to specific business units",
            },
            bu: {
                type: "string",
                description: "Single business unit (convenience alias for business_units[0])",
            },
            include_matching: {
                type: "boolean",
                description: "Also list matching rows (default false)",
            },
        },
        required: ["close_quarter"],
    },
};
async function handleGetForecastIntegrity(args) {
    const quarter = requireQuarter(args.close_quarter);
    const email = str(args.email, "email", { max: 200 });
    const bu = str(args.bu, "bu", { max: 200 });
    const businessUnits = strArray(args.business_units, "business_units", { max: 100, maxItems: 25 });
    const includeMatching = bool(args.include_matching, "include_matching", false);
    const bus = businessUnits ?? (bu ? [bu] : undefined);
    const userGuid = await resolveUserGuid(email);
    const build = (top) => fetchXml({
        top,
        entity: {
            name: "sn_specialistforecast",
            attributes: [
                "sn_specialistforecastid",
                "sn_specialistforecastcategory",
                "sn_specialistforecastcategoryreporting",
                "sn_productnnacv",
                "sn_specialistnnacvreporting",
                "sn_forecasttype",
            ],
            filter: {
                type: "and",
                conditions: [eqGuid("ownerid", userGuid), eqInt("statecode", STATE_OPEN)],
            },
            links: [
                businessUnitLink(bus),
                {
                    name: "opportunity",
                    from: "opportunityid",
                    to: "sn_opportunity",
                    alias: "opp",
                    linkType: "inner",
                    attributes: ["name", "sn_number", "sn_closequarter", "estimatedclosedate"],
                    filter: {
                        type: "and",
                        conditions: [eqStr("sn_closequarter", quarter), eqInt("statecode", STATE_OPEN)],
                    },
                },
            ],
        },
    });
    const res = await queryAllFetchXml({
        entity: "sn_specialistforecasts",
        buildFetch: build,
        page_size: 500,
        max_pages: 20,
    });
    const mismatches = [];
    const matching = [];
    let totalDelta = 0;
    let totalOperational = 0;
    let totalReporting = 0;
    for (const row of res.value) {
        const opCat = row.sn_specialistforecastcategory ?? null;
        const repCat = row.sn_specialistforecastcategoryreporting ?? null;
        const opAcv = row.sn_productnnacv ?? 0;
        const repAcv = row.sn_specialistnnacvreporting ?? 0;
        totalOperational += opAcv;
        totalReporting += repAcv;
        const catMismatch = opCat !== repCat;
        const acvMismatch = Math.abs(opAcv - repAcv) > 0.005;
        if (!catMismatch && !acvMismatch) {
            if (includeMatching) {
                matching.push({
                    id: row.sn_specialistforecastid,
                    opportunity_number: row["opp.sn_number"],
                    business_unit: row["bu.sn_name"] ?? "Unknown",
                    category: CATEGORY_LABELS[opCat] ?? `unknown_${opCat}`,
                    nnacv: opAcv,
                });
            }
            continue;
        }
        const delta = opAcv - repAcv;
        totalDelta += delta;
        mismatches.push({
            id: row.sn_specialistforecastid,
            opportunity_number: row["opp.sn_number"] ?? null,
            opportunity_name: row["opp.name"] ?? null,
            business_unit: row["bu.sn_name"] ?? "Unknown",
            category_mismatch: catMismatch,
            category_operational: opCat === null ? null : CATEGORY_LABELS[opCat] ?? `unknown_${opCat}`,
            category_reporting: repCat === null ? null : CATEGORY_LABELS[repCat] ?? `unknown_${repCat}`,
            acv_mismatch: acvMismatch,
            nnacv_operational: opAcv,
            nnacv_reporting: repAcv,
            acv_delta: Math.round(delta * 100) / 100,
        });
    }
    return {
        quarter,
        business_units: bus ?? "all",
        rows_checked: res.value.length,
        mismatch_count: mismatches.length,
        mismatches: mismatches.sort((a, b) => Math.abs(b.acv_delta - a.acv_delta)),
        total_nnacv_operational: totalOperational,
        total_nnacv_reporting: totalReporting,
        total_acv_delta: Math.round(totalDelta * 100) / 100,
        delta_pct_of_operational: totalOperational !== 0
            ? Math.round((totalDelta / totalOperational) * 10000) / 100
            : null,
        truncated: res.truncated,
        verdict: mismatches.length === 0
            ? "consistent"
            : `DIVERGENT: ${mismatches.length} row(s) differ between operational and reporting columns`,
        ...(includeMatching ? { matching } : {}),
    };
}
// ===========================================================================
// get_closing_readiness (F4)
// ===========================================================================
const getClosingReadinessTool = {
    name: "get_closing_readiness",
    description: "Aggregates the ServiceNow closing checklist of an opportunity (~150 boolean fields) into 5 groups (order_form, commercial, stakeholder, solution, value), computes a completion ratio per group, lists blocking_items, and returns a verdict: ready_to_close / at_risk / early_stage. Blocking fields: sn_receivedpo, sn_customersignedorderformsowandpoprovidedt, sn_submitsigneddocumentsforclosure.",
    inputSchema: {
        type: "object",
        properties: {
            opportunity_id: { type: "string", description: "GUID of the opportunity" },
            opportunity_number: {
                type: "string",
                description: "Opportunity number like 'OPTY5331870'",
            },
        },
    },
};
async function handleGetClosingReadiness(args) {
    const opp = await resolveOpportunityId(str(args.opportunity_id, "opportunity_id"), str(args.opportunity_number, "opportunity_number"));
    const checklistFields = allChecklistFields();
    const readFields = [
        "opportunityid",
        "name",
        "sn_number",
        "estimatedclosedate",
        "estimatedvalue",
        "sn_netnewacv",
        "statecode",
        "statuscode",
        "sn_salesstage",
        "sn_forecastcategory",
        "sn_closequarter",
        "sn_opportunitytype",
        CLOSE_PROBABILITY_FIELD,
        SN_PROBABILITY_FIELD,
        ...checklistFields,
    ];
    const opp1 = await getRecord("opportunities", opp.id, readFields);
    // Lignes produit (peut être absent) — contribution au readiness commercial.
    const products = await queryRecords({
        entity: "opportunityproducts",
        filter: `_opportunityid_value eq ${odataString(opp.id)}`,
        select: ["opportunityproductid", "opportunityproductname", "sn_netnewannualcontractvalue", "extendedamount"],
        top: 50,
    }).catch(() => ({ value: [] }));
    const groups = CHECKLIST_GROUPS.map((g) => {
        let completed = 0;
        let answered = 0;
        const missing = [];
        const notAnswered = [];
        for (const f of g.fields) {
            const v = opp1[f];
            if (v === undefined || v === null) {
                notAnswered.push(f);
                continue;
            }
            answered += 1;
            if (v === true)
                completed += 1;
            else
                missing.push(f);
        }
        return {
            key: g.key,
            label: g.label,
            completed,
            total: answered,
            ratio: answered ? Math.round((completed / answered) * 100) : 0,
            missing_fields: missing,
            not_answered_fields: notAnswered,
        };
    });
    const totalCompleted = groups.reduce((s, g) => s + g.completed, 0);
    const totalAnswered = groups.reduce((s, g) => s + g.total, 0);
    const overallRatio = totalAnswered
        ? Math.round((totalCompleted / totalAnswered) * 100)
        : 0;
    const blockingItems = CLOSURE_BLOCKERS.map((f) => ({
        field: f,
        label: BLOCKER_LABELS[f] ?? f,
        done: opp1[f] === true,
        value: opp1[f] ?? null,
    }));
    const blockingPending = blockingItems.filter((b) => !b.done);
    const weakest = [...groups].sort((a, b) => a.ratio - b.ratio)[0];
    let verdict;
    let verdict_reason;
    if (statecode(opp1.statecode) !== STATE_OPEN) {
        verdict = "ready_to_close";
        verdict_reason = `Opportunity is not open (statecode=${opp1.statecode}); it is already won or lost.`;
    }
    else if (blockingPending.length > 0) {
        verdict = "at_risk";
        verdict_reason = `${blockingPending.length} blocking item(s) pending: ${blockingPending
            .map((b) => b.label)
            .join("; ")}.`;
    }
    else if (overallRatio >= 80) {
        verdict = "ready_to_close";
        verdict_reason = `All blocking items complete and ${overallRatio}% of the checklist is done.`;
    }
    else if (overallRatio >= 45) {
        verdict = "at_risk";
        verdict_reason = `No blocking item is pending but the checklist is only ${overallRatio}% complete (weakest group: ${weakest?.label ?? "n/a"} at ${weakest?.ratio ?? 0}%).`;
    }
    else {
        verdict = "early_stage";
        verdict_reason = `Checklist is only ${overallRatio}% complete — the deal is still early in the sales process.`;
    }
    const display = opp1[SN_PROBABILITY_FIELD];
    return {
        opportunity_id: opp.id,
        opportunity_number: opp.number ?? null,
        opportunity_name: opp1.name,
        statecode: opp1.statecode,
        statuscode: opp1.statuscode,
        close_date: opp1.estimatedclosedate,
        close_quarter: opp1.sn_closequarter,
        sn_forecastcategory: CATEGORY_LABELS[opp1.sn_forecastcategory] ?? opp1.sn_forecastcategory,
        close_probability: opp1[CLOSE_PROBABILITY_FIELD] ?? probabilityToNumber(display) ?? null,
        sn_probability_display: display,
        verdict,
        verdict_reason,
        blocking_items: blockingItems,
        blocking_pending: blockingPending.length,
        overall_ratio: overallRatio,
        groups,
        weakest_group: weakest?.key ?? null,
        product_line_count: products.value.length,
        product_lines_acv: products.value.reduce((s, p) => s + (p.sn_netnewannualcontractvalue ?? 0), 0),
    };
}
function statecode(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : STATE_OPEN;
}
// ===========================================================================
// get_team_forecast (F7)
// ===========================================================================
const getTeamForecastTool = {
    name: "get_team_forecast",
    description: "Manager rollup of a team's forecast for a quarter: ACV per rep per category, concentration (share of the top 3 reps, HHI), and the reps who have NO forecast at all. Uses server-side FetchXML aggregation so it does not cap at a few hundred rows.",
    inputSchema: {
        type: "object",
        properties: {
            close_quarter: { type: "string", description: "Quarter to roll up, e.g. '26-Q3'" },
            lead_email: {
                type: "string",
                description: "Lead's email. Defaults to the authenticated user. Used as the BU/team scope: all specialists who share a business unit with this lead's forecasts.",
            },
            bu: { type: "string", description: "Restrict to a single business unit" },
        },
        required: ["close_quarter"],
    },
};
async function handleGetTeamForecast(args) {
    const quarter = requireQuarter(args.close_quarter);
    const leadEmail = str(args.lead_email, "lead_email", { max: 200 });
    const bu = str(args.bu, "bu", { max: 200 });
    const leadGuid = await resolveUserGuid(leadEmail);
    // Périmètre : si aucun BU n'est donné, on restreint aux business units pour
    // lesquelles le lead a lui-même des lignes de prévision (scope « équipe »).
    let scopedBu = bu ? [bu] : undefined;
    let scopeNote = bu
        ? `Scoped to business unit '${bu}'.`
        : "Scoped to ALL business units (pass 'bu' to restrict).";
    if (!scopedBu) {
        const leadBus = await queryRecords({
            entity: "sn_specialistforecasts",
            fetchxml: fetchXml({
                top: 100,
                entity: {
                    name: "sn_specialistforecast",
                    attributes: ["sn_specialistforecastid"],
                    filter: { type: "and", conditions: [eqGuid("ownerid", leadGuid)] },
                    links: [businessUnitLink(undefined)],
                },
            }),
        });
        const names = [
            ...new Set(leadBus.value
                .map((r) => r["bu.sn_name"])
                .filter((n) => !!n)),
        ];
        if (names.length) {
            scopedBu = names;
            scopeNote = `Scoped to the business units of the lead's own forecasts: ${names.join(", ")}.`;
        }
        else {
            scopeNote =
                "The lead has no specialist forecast row to derive a team scope from, so ALL business units are included. Pass 'bu' to restrict.";
        }
    }
    const aggregate = (top) => fetchXml({
        top,
        entity: {
            name: "sn_specialistforecast",
            aggregate: true,
            attributes: [
                aggAttribute("sn_productnnacv", "sum", "agg_sum_nnacv"),
                aggAttribute("sn_productnnacv", "max", "agg_max_nnacv"),
                aggAttribute("sn_specialistforecastid", "count", "agg_count_lines"),
            ],
            filter: { type: "and", conditions: [eqInt("statecode", STATE_OPEN)] },
            links: [
                {
                    ...businessUnitLink(scopedBu),
                    attributes: [groupByAttribute("sn_name", "grp_business_unit")],
                },
                {
                    name: "systemuser",
                    from: "ownerid",
                    to: "systemuserid",
                    alias: "rep",
                    linkType: "inner",
                    attributes: [groupByAttribute("fullname", "grp_rep")],
                },
                {
                    name: "opportunity",
                    from: "opportunityid",
                    to: "sn_opportunity",
                    alias: "opp",
                    linkType: "inner",
                    attributes: [],
                    filter: {
                        type: "and",
                        conditions: [eqStr("sn_closequarter", quarter), eqInt("statecode", STATE_OPEN)],
                    },
                },
            ],
            order: [{ attribute: "agg_sum_nnacv", descending: true }],
        },
    });
    const res = await queryAllFetchXml({
        entity: "sn_specialistforecasts",
        buildFetch: aggregate,
        page_size: 500,
        max_pages: 10,
    });
    const rows = res.value;
    const reps = new Map();
    let totalAcv = 0;
    for (const r of rows) {
        const rep = r.grp_rep ?? "Unknown";
        const bun = r.grp_business_unit ?? "Unknown";
        const acv = Number(r.agg_sum_nnacv ?? 0) || 0;
        const lines = Number(r.agg_count_lines ?? 0) || 0;
        if (!reps.has(rep))
            reps.set(rep, { rep, business_units: new Set(), acv: 0, lines: 0 });
        const entry = reps.get(rep);
        entry.business_units.add(bun);
        entry.acv += acv;
        entry.lines += lines;
        totalAcv += acv;
    }
    const repList = [...reps.values()].sort((a, b) => b.acv - a.acv);
    const top3Acv = repList.slice(0, 3).reduce((s, r) => s + r.acv, 0);
    const hhi = totalAcv
        ? Math.round(repList.reduce((s, r) => s + Math.pow((r.acv / totalAcv) * 100, 2), 0) * 100) / 100
        : 0;
    // Reps sans AUCUNE prévision : roster approximatif dérivé des specialists
    // actifs sur ces BUs (hors trimestre courant).
    const roster = await queryRecords({
        entity: "sn_specialistforecasts",
        fetchxml: fetchXml({
            top: 1000,
            entity: {
                name: "sn_specialistforecast",
                attributes: ["sn_specialistforecastid"],
                filter: { type: "and", conditions: [eqInt("statecode", STATE_OPEN)] },
                links: [
                    { ...businessUnitLink(scopedBu), attributes: [] },
                    {
                        name: "systemuser",
                        from: "ownerid",
                        to: "systemuserid",
                        alias: "rep",
                        linkType: "inner",
                        attributes: ["fullname"],
                    },
                ],
            },
        }),
    }).catch(() => ({ value: [] }));
    const rosterNames = new Set();
    for (const r of roster.value) {
        if (r["rep.fullname"])
            rosterNames.add(String(r["rep.fullname"]));
    }
    const repsWithoutForecast = [...rosterNames].filter((n) => !reps.has(n)).sort();
    return {
        quarter,
        scope: {
            lead_email: leadEmail ?? "<authenticated user>",
            business_units: scopedBu ?? "all",
            scope_note: scopeNote,
            roster_note: "The rep roster is inferred from specialists having any active sn_specialistforecast row in scope; it is not a systemuser/team roster.",
        },
        total_acv: totalAcv,
        rep_count: repList.length,
        group_rows: rows.length,
        reps: repList.map((r) => ({
            rep: r.rep,
            acv: r.acv,
            forecast_lines: r.lines,
            business_units: [...r.business_units],
            share_of_total_pct: totalAcv ? Math.round((r.acv / totalAcv) * 10000) / 100 : 0,
        })),
        concentration: {
            top3_acv: top3Acv,
            top3_share_pct: totalAcv ? Math.round((top3Acv / totalAcv) * 10000) / 100 : 0,
            herfindahl_index: hhi,
            interpretation: hhi > 2500
                ? "HIGHLY concentrated — the quarter depends on a few reps."
                : hhi > 1500
                    ? "Moderately concentrated."
                    : "Well distributed across the team.",
        },
        reps_without_forecast: repsWithoutForecast,
        reps_without_forecast_count: repsWithoutForecast.length,
        truncated: res.truncated,
    };
}
// ===========================================================================
export const forecastTools = [
    getSpecialistOpportunitiesTool,
    getForecastSummaryTool,
    updateSpecialistForecastTool,
    getAtRiskDealsTool,
    getForecastIntegrityTool,
    getClosingReadinessTool,
    getTeamForecastTool,
];
export const forecastHandlers = {
    get_specialist_opportunities: handleGetSpecialistOpportunities,
    get_forecast_summary: handleGetForecastSummary,
    update_specialist_forecast: handleUpdateSpecialistForecast,
    get_at_risk_deals: handleGetAtRiskDeals,
    get_forecast_integrity: handleGetForecastIntegrity,
    get_closing_readiness: handleGetClosingReadiness,
    get_team_forecast: handleGetTeamForecast,
};
//# sourceMappingURL=forecast.js.map