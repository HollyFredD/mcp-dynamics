import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  queryRecords,
  queryAllFetchXml,
  createRecord,
  updateRecord,
  getRecord,
  deleteRecord,
  resolveUserGuid,
  assertEntityWritable,
  resolveCurrencyGuid,
  resolvePrimaryUnitId,
} from "../dataverse.js";
import { odataString } from "../odata.js";
import {
  fetchXml,
  eqInt,
  eqStr,
  eqGuid,
  type ConditionSpec,
  type FilterSpec,
} from "../fetchxml.js";
import {
  STATUS_CODES,
  STATUS_CHOICES,
  STATE_OPEN,
  FORECAST_CODES,
  FORECAST_CHOICES,
  FORECAST_WRITABLE,
  COLLAB_NOTE_TYPES,
  COLLAB_NOTE_TYPE_CHOICES,
  DEFAULT_COLLAB_NOTE_TYPE,
  SUBJECT_MAX_LENGTH,
  DEFAULT_CURRENCY,
  SUPPORTED_CURRENCIES,
  ROLE_CHOICES,
  ROLE_FIELDS,
  CLOSE_PROBABILITY_FIELD,
  SN_PROBABILITY_FIELD,
} from "../constants.js";
import {
  bool,
  intIn,
  isoDate,
  oneOf,
  requiredStr,
  str,
  amount,
} from "../validate.js";
import { quarterOfDate } from "../dates.js";
import {
  buildDiff,
  logMutation,
  maybeQuarter,
  resolveOpportunityId,
  verifyWrite,
} from "./common.js";
import type { ToolDef, ToolHandler } from "./crud.js";

const DRY_RUN_PROP = {
  dry_run: {
    type: "boolean",
    description:
      "When true (DEFAULT) nothing is written: the tool returns the exact diff it WOULD apply. Set false to actually write.",
  },
} as const;

const IDENTIFIER_PROPS = {
  opportunity_id: {
    type: "string",
    description: "GUID of the opportunity (use this or opportunity_number)",
  },
  opportunity_number: {
    type: "string",
    description: "Opportunity number like 'OPTY5331870' (use this or opportunity_id)",
  },
} as const;

const OPC_SELECT = [
  "name",
  "sn_number",
  "sn_salesstage",
  "sn_forecastcategory",
  "estimatedclosedate",
  "sn_netnewacv",
  "sn_renewalacv",
  "sn_totalvalue",
  "statecode",
  "statuscode",
  "sn_closequarter",
  "sn_opportunitytype",
  "sn_opportunitybulist",
  "sn_channeltransactiontype",
  "_customerid_value",
  "_ownerid_value",
  "_sn_fieldsalesrep_value",
  "_sn_solutionconsultant_value",
  CLOSE_PROBABILITY_FIELD,
  SN_PROBABILITY_FIELD,
] as const;

/** Extrait sn_probability (string "100%") en nombre, quand c'est possible. */
export function probabilityToNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace("%", "").trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// ===========================================================================
// get_my_opportunities
// ===========================================================================
const getMyOpportunitiesTool: ToolDef = {
  name: "get_my_opportunities",
  description:
    "Get opportunities associated with a user by role (owner, field sales rep, solution consultant, secondary sales rep, renewal account manager). Defaults to the currently authenticated Azure CLI user. Always returns sn_number, sn_netnewacv (local currency), closeprobability (numeric) and sn_probability (calculated display string).",
  inputSchema: {
    type: "object",
    properties: {
      email: {
        type: "string",
        description: "Email of the user (defaults to the authenticated Azure CLI user)",
      },
      role: {
        type: "string",
        enum: ROLE_CHOICES,
        description:
          "Which role field to filter by. 'any' (default) checks all five role fields at once, including renewal_account_manager.",
      },
      status: {
        type: "string",
        enum: STATUS_CHOICES,
        description: "Filter by opportunity status (default: 'open')",
      },
      forecast_category: {
        type: "string",
        enum: FORECAST_CHOICES,
        description: "Filter by SN forecast category (pipeline|best_case|committed|closed|upside)",
      },
      close_quarter: {
        type: "string",
        description: "Close quarter in ANY accepted format, normalized to 'YY-Qn' (e.g. '26-Q3', '2026-Q3', '26Q3')",
      },
      top: { type: "number", description: "Maximum records to return (default 50, max 1000)" },
      fetch_all: {
        type: "boolean",
        description: "Follow pagination so nothing is silently dropped (default false)",
      },
    },
  },
};

async function handleGetMyOpportunities(args: Record<string, unknown>): Promise<unknown> {
  const email = str(args.email, "email", { max: 200 });
  const role = oneOf(args.role, ROLE_CHOICES, "role", "any");
  const status = oneOf(args.status, STATUS_CHOICES, "status", "open");
  const forecast = oneOf(args.forecast_category, FORECAST_CHOICES, "forecast_category");
  const quarter = maybeQuarter(args.close_quarter);
  const top = intIn(args.top, "top", { def: 50, min: 1, max: 1000 });
  const fetchAll = bool(args.fetch_all, "fetch_all", false);

  const userGuid = await resolveUserGuid(email);

  const roleFields =
    role && role !== "any"
      ? [ROLE_FIELDS[role as keyof typeof ROLE_FIELDS]]
      : Object.values(ROLE_FIELDS);
  const roleFilter = roleFields.map((f) => `${f} eq ${odataString(userGuid)}`).join(" or ");

  const filters: string[] = [`(${roleFilter})`];
  if (status && status !== "all") {
    filters.push(`statecode eq ${STATUS_CODES[status as keyof typeof STATUS_CODES]}`);
  }
  if (forecast && forecast !== "all") {
    filters.push(`sn_forecastcategory eq ${FORECAST_CODES[forecast as keyof typeof FORECAST_CODES]}`);
  }
  if (quarter) filters.push(`sn_closequarter eq ${odataString(quarter)}`);

  const base = {
    entity: "opportunities",
    filter: filters.join(" and "),
    select: [...OPC_SELECT],
    orderby: "estimatedclosedate asc",
    count: true,
  };

  const res = fetchAll
    ? await queryAllFetchXmlEntity(base, top)
    : await queryRecords({ ...base, top });

  const rows = res.value.map(decorateOpportunity);
  const total = res["@odata.count"];

  return {
    filters: {
      email: email ?? "<authenticated user>",
      role: role ?? "any",
      status: status ?? "open",
      forecast_category: forecast ?? "all",
      close_quarter: quarter ?? null,
      user_id: userGuid,
    },
    row_count: rows.length,
    total_count: total ?? null,
    truncated: rows.length >= top,
    has_more: rows.length >= top,
    opportunities: rows,
  };
}

/** queryAllFetchXml n'a pas de FetchXML ici : on délègue à queryAll. */
async function queryAllFetchXmlEntity(
  base: { entity: string; filter: string; select: string[]; orderby: string },
  top: number
) {
  const { queryAll } = await import("../dataverse.js");
  return queryAll({ ...base, page_size: top, max_pages: 10, count: true });
}

function decorateOpportunity(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  // sn_probability est CALCULÉ et de type string : on le rend explicite et on
  // expose la vraie probabilité numérique à côté.
  const display = row[SN_PROBABILITY_FIELD];
  if (display !== undefined) {
    out.sn_probability_display = display;
    delete out[SN_PROBABILITY_FIELD];
  }
  out.close_probability = row[CLOSE_PROBABILITY_FIELD] ?? probabilityToNumber(display) ?? null;
  return out;
}

// ===========================================================================
// search_opportunities
// ===========================================================================
const searchOpportunitiesTool: ToolDef = {
  name: "search_opportunities",
  description:
    "Search opportunities by opportunity name OR account name (single FetchXML query, identical substring semantics on both branches). Results are merged, deduplicated, THEN truncated, and the response reports returned / total_found / has_more.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Substring matched against opportunity name and account name",
      },
      status: {
        type: "string",
        enum: STATUS_CHOICES,
        description: "Filter by opportunity status (default: open)",
      },
      close_quarter: {
        type: "string",
        description: "Optionally restrict to a close quarter, e.g. '26-Q3'",
      },
      top: { type: "number", description: "Max number of results (default 15, max 200)" },
    },
    required: ["query"],
  },
};

async function handleSearchOpportunities(args: Record<string, unknown>): Promise<unknown> {
  const query = requiredStr(args.query, "query", { max: 200 });
  const status = oneOf(args.status, STATUS_CHOICES, "status", "open");
  const quarter = maybeQuarter(args.close_quarter);
  const top = intIn(args.top, "top", { def: 15, min: 1, max: 200 });

  const conditions: ConditionSpec[] = [
    {
      attribute: "name",
      operator: "like",
      value: `%${query}%`,
    },
  ];
  if (status && status !== "all") {
    conditions.unshift(eqInt("statecode", STATUS_CODES[status as keyof typeof STATUS_CODES]));
  }
  if (quarter) conditions.push(eqStr("sn_closequarter", quarter));

  // H16 : une seule requête, donc une seule sémantique de recherche, et aucune
  // fusion « avant troncature ».
  const build = (fetchTop: number) =>
    fetchXml({
      top: fetchTop,
      entity: {
        name: "opportunity",
        attributes: [
          "opportunityid",
          "name",
          "sn_number",
          "sn_salesstage",
          "sn_forecastcategory",
          "estimatedclosedate",
          "sn_netnewacv",
          "sn_closequarter",
          "statecode",
          CLOSE_PROBABILITY_FIELD,
          SN_PROBABILITY_FIELD,
        ],
        filter: { type: "and", conditions },
        links: [
          {
            name: "account",
            from: "accountid",
            to: "customerid",
            alias: "acc",
            linkType: "inner",
            attributes: [{ name: "name", alias: "account_name" }],
            filter: { type: "and", conditions: [{ attribute: "name", operator: "like", value: `%${query}%` }] },
          },
        ],
        order: [{ attribute: "estimatedclosedate", descending: false }],
      },
    });

  const res = await queryAllFetchXml({
    entity: "opportunities",
    buildFetch: build,
    page_size: Math.max(top, 50),
    max_pages: 4,
  });

  const all = res.value.map((r) => {
    const row = decorateOpportunity(r);
    row.account_name = r["acc.account_name"];
    return row;
  });

  return {
    query,
    status: status ?? "open",
    close_quarter: quarter ?? null,
    total_found: all.length,
    returned: Math.min(all.length, top),
    has_more: all.length > top,
    truncated: all.length > top,
    opportunities: all.slice(0, top),
  };
}

// ===========================================================================
// get_opportunity_products
// ===========================================================================
const getOpportunityProductsTool: ToolDef = {
  name: "get_opportunity_products",
  description:
    "Get the product lines (SKUs) of an opportunity from opportunityproducts: name, product, business unit, net new ACV, annual rate, start date, currency. Use this to see WHAT is being sold. NOT the specialist forecast — use get_specialist_opportunities for that.",
  inputSchema: {
    type: "object",
    properties: {
      ...IDENTIFIER_PROPS,
    },
  },
};

async function handleGetOpportunityProducts(args: Record<string, unknown>): Promise<unknown> {
  const opp = await resolveOpportunityId(
    str(args.opportunity_id, "opportunity_id"),
    str(args.opportunity_number, "opportunity_number")
  );

  const fetchxml = fetchXml({
    entity: {
      name: "opportunityproduct",
      attributes: [
        "opportunityproductid",
        "opportunityproductname",
        "productname",
        "sn_productbusinessunitid",
        "sn_netnewannualcontractvalue",
        "extendedamount",
        "sn_annualrateamount",
        "quantity",
        "priceperunit",
        "sn_startdateopportunityproduct",
        "sn_renewalacv",
        "sn_opportunitylinedefaultmetric",
        "sequencenumber",
        "transactioncurrencyid",
      ],
      filter: { type: "and", conditions: [eqGuid("opportunityid", opp.id)] },
      order: [{ attribute: "sequencenumber", descending: false }],
    },
  });

  const res = await queryRecords({ entity: "opportunityproducts", fetchxml });
  return {
    opportunity_id: opp.id,
    opportunity_number: opp.number ?? null,
    line_count: res.value.length,
    product_lines: res.value,
  };
}

// ===========================================================================
// get_collaboration_notes / add_collaboration_note
// ===========================================================================
const getCollaborationNotesTool: ToolDef = {
  name: "get_collaboration_notes",
  description:
    "Get Collaboration Notes for an opportunity, most recent first. Accepts the opportunity GUID or its number (e.g. 'OPTY5331870').",
  inputSchema: {
    type: "object",
    properties: {
      ...IDENTIFIER_PROPS,
      note_type: {
        type: "string",
        enum: COLLAB_NOTE_TYPE_CHOICES,
        description: "Filter by note type (optional, all types if omitted)",
      },
      top: { type: "number", description: "Maximum notes to return (default 20, max 200)" },
    },
  },
};

async function handleGetCollaborationNotes(args: Record<string, unknown>): Promise<unknown> {
  const opp = await resolveOpportunityId(
    str(args.opportunity_id, "opportunity_id"),
    str(args.opportunity_number, "opportunity_number")
  );
  const noteType = oneOf(args.note_type, COLLAB_NOTE_TYPE_CHOICES, "note_type");
  const top = intIn(args.top, "top", { def: 20, min: 1, max: 200 });

  const filters = [`_regardingobjectid_value eq ${odataString(opp.id)}`];
  if (noteType) {
    filters.push(`sn_activitynotetype eq ${COLLAB_NOTE_TYPES[noteType]}`);
  }

  const res = await queryRecords({
    entity: "sn_activitycustomnoteses",
    filter: filters.join(" and "),
    select: [
      "subject",
      "sn_activitycustomnotes",
      "sn_activitynotetype",
      "createdon",
      "_createdby_value",
    ],
    orderby: "createdon desc",
    top,
  });

  return {
    opportunity_id: opp.id,
    opportunity_number: opp.number ?? null,
    note_count: res.value.length,
    truncated: res.value.length >= top,
    has_more: res.value.length >= top,
    notes: res.value,
  };
}

const addCollaborationNoteTool: ToolDef = {
  name: "add_collaboration_note",
  description:
    "Add a Collaboration Note to an opportunity. DRY RUN by default (returns the note that would be created). The derived subject is truncated to 100 characters (Dataverse rejects longer values).",
  inputSchema: {
    type: "object",
    properties: {
      ...IDENTIFIER_PROPS,
      note: {
        type: "string",
        description: "Text content of the collaboration note (must not be empty)",
      },
      note_type: {
        type: "string",
        enum: COLLAB_NOTE_TYPE_CHOICES,
        description: `Type of note (default: '${DEFAULT_COLLAB_NOTE_TYPE}')`,
      },
      subject: {
        type: "string",
        description: "Subject line (auto-derived and truncated to 100 chars if omitted)",
      },
      ...DRY_RUN_PROP,
    },
    required: ["note"],
  },
};

/** Tronque proprement à 100 caractères sans couper au milieu d'un mot si possible. */
export function truncateSubject(text: string, max = SUBJECT_MAX_LENGTH): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

async function handleAddCollaborationNote(args: Record<string, unknown>): Promise<unknown> {
  assertEntityWritable("sn_activitycustomnoteses");
  const opp = await resolveOpportunityId(
    str(args.opportunity_id, "opportunity_id"),
    str(args.opportunity_number, "opportunity_number")
  );
  const note = requiredStr(args.note, "note", { max: 32_000 });
  const noteType =
    oneOf(args.note_type, COLLAB_NOTE_TYPE_CHOICES, "note_type", DEFAULT_COLLAB_NOTE_TYPE) ??
    DEFAULT_COLLAB_NOTE_TYPE;
  const dryRun = bool(args.dry_run, "dry_run", true) ?? true;

  const subject = truncateSubject(
    str(args.subject, "subject", { max: 4000 }) ?? note
  );
  if (!subject) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "The collaboration note would have an empty subject. Provide a non-empty 'note' or an explicit 'subject'."
    );
  }

  assertEntityWritable("sn_activitycustomnoteses");

  const data: Record<string, unknown> = {
    subject,
    sn_activitycustomnotes: note,
    sn_activitynotetype: COLLAB_NOTE_TYPES[noteType],
    "regardingobjectid_opportunity_sn_activitycustomnotes@odata.bind": `/opportunities(${opp.id})`,
  };

  if (dryRun) {
    return {
      dry_run: true,
      opportunity_id: opp.id,
      opportunity_number: opp.number ?? null,
      would_create: data,
      subject_length: subject.length,
      next_step: "Call again with dry_run=false to create the note.",
    };
  }

  const created = await createRecord("sn_activitycustomnoteses", data);
  logMutation("add_collaboration_note", {
    opportunity: opp.number ?? opp.id,
    note_type: noteType,
    id: created.id,
  });
  return {
    dry_run: false,
    id: created.id,
    opportunity_id: opp.id,
    opportunity_number: opp.number ?? null,
    note_type: noteType,
    subject,
    created: true,
  };
}

// ===========================================================================
// add_opportunity_product
// ===========================================================================
const addOpportunityProductTool: ToolDef = {
  name: "add_opportunity_product",
  description:
    "Add a product line and its sub-product to an opportunity. Idempotent: if a sub-product line already exists for (parent line, sub-product), nothing is duplicated. The percentage is computed on the REMAINING amount and the parent line is recalculated afterwards. DRY RUN by default. Ambiguous product names raise an error listing the candidates instead of picking one at random.",
  inputSchema: {
    type: "object",
    properties: {
      ...IDENTIFIER_PROPS,
      product_name: {
        type: "string",
        description: "Name of the parent forecast product, e.g. 'Security Forecast'",
      },
      sub_product_name: {
        type: "string",
        description: "Name of the sub-product, e.g. 'Veza Forecast' or 'Veza'",
      },
      nnacv: { type: "number", description: "Net New ACV for this sub-product line" },
      currency: {
        type: "string",
        enum: SUPPORTED_CURRENCIES,
        description: `ISO currency code (default: ${DEFAULT_CURRENCY})`,
      },
      start_date: {
        type: "string",
        description: "Start date for the product line in YYYY-MM-DD format (optional)",
      },
      ...DRY_RUN_PROP,
    },
    required: ["product_name", "sub_product_name", "nnacv"],
  },
};

interface Candidate {
  id: string;
  name: string;
}

async function resolveProduct(name: string): Promise<Candidate> {
  // H10 : tri déterministe + priorité à la correspondance exacte.
  const res = await queryRecords({
    entity: "products",
    filter: `contains(name, ${odataString(name)}) and statecode eq 0`,
    select: ["productid", "name"],
    orderby: "name asc",
    top: 25,
  });

  const candidates = (res.value as { productid: string; name: string }[]).map((p) => ({
    id: p.productid,
    name: p.name,
  }));

  if (!candidates.length) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `No active product found matching '${name}'. Verify the exact product name, or create it in Dynamics first.`
    );
  }

  const lower = name.trim().toLowerCase();
  const exact = candidates.filter((c) => c.name.trim().toLowerCase() === lower);
  if (exact.length === 1) return exact[0];

  const pool = exact.length ? exact : candidates;
  if (pool.length === 1) return pool[0];

  throw new McpError(
    ErrorCode.InvalidParams,
    `Ambiguous product name '${name}': ${pool.length} active products match. Re-call with one of these exact names: ${pool
      .slice(0, 10)
      .map((c) => `'${c.name}'`)
      .join(", ")}.`
  );
}

async function resolveSubProduct(
  name: string,
  productId: string
): Promise<Candidate & { parent: string }> {
  const res = await queryRecords({
    entity: "sn_subproducts",
    fetchxml: fetchXml({
      top: 25,
      entity: {
        name: "sn_subproduct",
        attributes: ["sn_subproductid", "sn_name", "sn_parentproduct"],
        filter: {
          type: "and",
          conditions: [
            { attribute: "sn_name", operator: "like", value: `%${name}%` },
            eqGuid("sn_parentproduct", productId),
            eqInt("statecode", 0),
          ],
        },
        order: [{ attribute: "sn_name", descending: false }],
      },
    }),
  });

  const candidates = (res.value as { sn_subproductid: string; sn_name: string }[]).map((s) => ({
    id: s.sn_subproductid,
    name: s.sn_name,
    parent: productId,
  }));

  if (!candidates.length) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `No active sub-product matching '${name}' under the selected parent product. Verify the sub-product name.`
    );
  }

  const lower = name.trim().toLowerCase();
  const exact = candidates.filter((c) => c.name.trim().toLowerCase() === lower);
  if (exact.length === 1) return exact[0];

  const pool = exact.length ? exact : candidates;
  if (pool.length === 1) return pool[0];

  throw new McpError(
    ErrorCode.InvalidParams,
    `Ambiguous sub-product name '${name}': ${pool.length} sub-products match under this parent. Re-call with one of these exact names: ${pool
      .slice(0, 10)
      .map((c) => `'${c.name}'`)
      .join(", ")}.`
  );
}

async function handleAddOpportunityProduct(args: Record<string, unknown>): Promise<unknown> {
  assertEntityWritable("opportunityproducts");
  assertEntityWritable("sn_opportunitysubproductses");

  const opp = await resolveOpportunityId(
    str(args.opportunity_id, "opportunity_id"),
    str(args.opportunity_number, "opportunity_number")
  );
  const productName = requiredStr(args.product_name, "product_name", { max: 200 });
  const subProductName = requiredStr(args.sub_product_name, "sub_product_name", { max: 200 });
  const nnacv = amount(args.nnacv, "nnacv");
  const currency = (
    oneOf(args.currency, SUPPORTED_CURRENCIES, "currency", DEFAULT_CURRENCY) ?? DEFAULT_CURRENCY
  ).toUpperCase();
  const startDate = args.start_date !== undefined && args.start_date !== null && args.start_date !== ""
    ? isoDate(args.start_date, "start_date")
    : undefined;
  const dryRun = bool(args.dry_run, "dry_run", true) ?? true;

  const product = await resolveProduct(productName);
  const subProduct = await resolveSubProduct(subProductName, product.id);

  // 1. Ligne parente existante ?
  const existing = await queryRecords({
    entity: "opportunityproducts",
    filter: `_opportunityid_value eq ${odataString(opp.id)} and _productid_value eq ${odataString(
      product.id
    )}`,
    select: [
      "opportunityproductid",
      "extendedamount",
      "priceperunit",
      "sn_netnewannualcontractvalue",
      "quantity",
      "ispriceoverridden",
    ],
    top: 1,
  });

  let oppProductId: string;
  let parentAmount: number;
  let createdParent = false;
  const parentRow = existing.value[0];

  if (parentRow) {
    oppProductId = String(parentRow.opportunityproductid).toLowerCase();
    // extendedamount peut être null ou NaN : on le traite explicitement.
    const ext = Number(parentRow.extendedamount);
    const nn = Number(parentRow.sn_netnewannualcontractvalue);
    parentAmount = Number.isFinite(ext) && ext !== 0
      ? ext
      : Number.isFinite(nn) && nn !== 0
        ? nn
        : nnacv;
  } else {
    oppProductId = "";
    parentAmount = nnacv;
  }

  // 2. Idempotence : existe-t-il déjà une ligne (parent, sub-product) ?
  const dup = await queryRecords({
    entity: "sn_opportunitysubproductses",
    filter:
      `_sn_opportunity_value eq ${odataString(opp.id)} and _sn_opportunityproduct_value eq ${odataString(
        oppProductId || "-"
      )} and _sn_subproduct_value eq ${odataString(subProduct.id)}`,
    select: ["sn_opportunitysubproductid", "sn_amount", "sn_percentage"],
    top: 1,
  });

  const alreadyAllocated = (existing.value as Record<string, unknown>[]).length
    ? await allocatedForSubProducts(opp.id, oppProductId, subProduct.id)
    : 0;

  const remaining = parentAmount - alreadyAllocated;
  const percentage = remaining > 0 ? Math.round((nnacv / remaining) * 100) : 100;

  const currencyId = await resolveCurrencyGuid(currency);
  const uomId = await resolvePrimaryUnitId();

  const plan = {
    opportunity_id: opp.id,
    opportunity_number: opp.number ?? null,
    parent_product: product.name,
    sub_product: subProduct.name,
    nnacv,
    currency,
    parent_line_id: oppProductId || null,
    parent_line_will_be_created: !parentRow,
    parent_amount: parentAmount,
    already_allocated_to_other_subproducts: alreadyAllocated,
    remaining_before: remaining,
    percentage_of_remaining: percentage,
    duplicate_sub_product_line: dup.value.length > 0,
  };

  if (dup.value.length) {
    return {
      dry_run: true,
      idempotent_noop: true,
      message: `A line for '${subProduct.name}' under '${product.name}' already exists — nothing to do.`,
      existing_line: dup.value[0],
      plan,
      next_step: "No action required. Pass a different sub_product_name to add another line.",
    };
  }

  if (dryRun) {
    return {
      dry_run: true,
      plan,
      next_step: "Call again with dry_run=false to create the line(s).",
    };
  }

  // 3. Création de la ligne parente si nécessaire
  if (!parentRow) {
    const lineData: Record<string, unknown> = {
      "opportunityid@odata.bind": `/opportunities(${opp.id})`,
      "productid@odata.bind": `/products(${product.id})`,
      "uomid@odata.bind": `/uoms(${uomId})`,
      ispriceoverridden: true,
      priceperunit: nnacv,
      quantity: 1,
      sn_netnewannualcontractvalue: nnacv,
    };
    if (startDate) lineData.sn_startdateopportunityproduct = startDate;
    const created = await createRecord("opportunityproducts", lineData);
    oppProductId = created.id;
    createdParent = true;
    logMutation("add_opportunity_product.parent_created", { id: oppProductId });
  }

  // 4. Ligne sous-produit — avec COMPENSATION si elle échoue (C5).
  try {
    const subLine = await createRecord("sn_opportunitysubproductses", {
      "sn_subproduct@odata.bind": `/sn_subproducts(${subProduct.id})`,
      "sn_opportunity@odata.bind": `/opportunities(${opp.id})`,
      "sn_opportunityproduct@odata.bind": `/opportunityproducts(${oppProductId})`,
      sn_amount: nnacv,
      sn_percentage: percentage,
      sn_opportunityproductamount: parentAmount,
      "transactioncurrencyid@odata.bind": `/transactioncurrencies(${currencyId})`,
      sn_currencycode: currency,
    });

    // 5. Recalcul du parent (H10 : priceperunit n'était jamais recalculé)
    const totalAllocated = await allocatedForSubProducts(opp.id, oppProductId, subProduct.id);
    const newParentAmount = Math.max(parentAmount, totalAllocated);
    await updateRecord(
      "opportunityproducts",
      oppProductId,
      {
        priceperunit: newParentAmount,
        sn_netnewannualcontractvalue: newParentAmount,
      },
      ["priceperunit", "sn_netnewannualcontractvalue"]
    ).catch(() => undefined);

    logMutation("add_opportunity_product", {
      opportunity: opp.number ?? opp.id,
      parent: product.name,
      sub_product: subProduct.name,
      nnacv,
      parent_line: oppProductId,
      sub_line: subLine.id,
    });

    const reread = await getRecord(
      "opportunityproducts",
      oppProductId,
      ["opportunityproductid", "extendedamount", "priceperunit", "sn_netnewannualcontractvalue"]
    ).catch(() => undefined);

    return {
      dry_run: false,
      created: true,
      message: `Added ${subProduct.name} (${currency} ${nnacv.toLocaleString()}) under ${product.name}`,
      parentProductLine: { id: oppProductId, created: createdParent, read_back: reread ?? null },
      subProductLine: { id: subLine.id },
      totals: {
        parent_amount_before: parentAmount,
        total_allocated: totalAllocated,
        percentage_of_remaining: percentage,
      },
    };
  } catch (err) {
    // COMPENSATION : on supprime la ligne parente orpheline qu'on vient de créer.
    if (createdParent) {
      try {
        await deleteRecord("opportunityproducts", oppProductId);
        logMutation("add_opportunity_product.rollback", {
          parent_line: oppProductId,
          reason: "sub-product creation failed",
        });
      } catch {
        /* la suppression de compensation a échoué : le signaler */
      }
      throw new McpError(
        ErrorCode.InternalError,
        `Creating the sub-product line failed and the auto-created parent line ${oppProductId} was rolled back. Nothing was persisted. Cause: ${
          err instanceof McpError ? err.message : String(err)
        }`
      );
    }
    throw err;
  }
}

/** Somme des montants déjà alloués aux sous-produits d'une ligne parente. */
async function allocatedForSubProducts(
  oppId: string,
  parentId: string,
  excludeSubProductId?: string
): Promise<number> {
  const res = await queryRecords({
    entity: "sn_opportunitysubproductses",
    filter:
      `_sn_opportunity_value eq ${odataString(oppId)} and _sn_opportunityproduct_value eq ${odataString(
        parentId
      )}`,
    select: ["sn_amount", "_sn_subproduct_value"],
    top: 100,
  });
  let sum = 0;
  for (const row of res.value as Record<string, unknown>[]) {
    if (excludeSubProductId && row._sn_subproduct_value === excludeSubProductId) continue;
    const n = Number(row.sn_amount);
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
}

// ===========================================================================
// update_opportunity_forecast
// ===========================================================================
const updateOpportunityForecastTool: ToolDef = {
  name: "update_opportunity_forecast",
  description:
    "Update the forecast category, close date or close quarter on an opportunity. DRY RUN by default (returns the exact diff). If close_date is given without close_quarter, the quarter is RECOMPUTED from the date so the deal does not stay counted in the wrong quarter. After writing, the record is re-read and verified field by field.",
  inputSchema: {
    type: "object",
    properties: {
      ...IDENTIFIER_PROPS,
      forecast_category: {
        type: "string",
        enum: FORECAST_WRITABLE,
        description: "New forecast category (pipeline|best_case|committed|upside). Never 'won' or 'lost'.",
      },
      close_date: { type: "string", description: "New close date in YYYY-MM-DD format" },
      close_quarter: {
        type: "string",
        description: "New close quarter, e.g. '26-Q3' (normalized automatically)",
      },
      ...DRY_RUN_PROP,
    },
  },
};

async function handleUpdateOpportunityForecast(args: Record<string, unknown>): Promise<unknown> {
  assertEntityWritable("opportunities");

  const opp = await resolveOpportunityId(
    str(args.opportunity_id, "opportunity_id"),
    str(args.opportunity_number, "opportunity_number")
  );
  const forecastCategory = oneOf(
    args.forecast_category,
    FORECAST_WRITABLE as unknown as string[],
    "forecast_category"
  );
  const closeDate =
    args.close_date !== undefined && args.close_date !== null && args.close_date !== ""
      ? isoDate(args.close_date, "close_date")
      : undefined;
  const explicitQuarter = maybeQuarter(args.close_quarter);
  const dryRun = bool(args.dry_run, "dry_run", true) ?? true;

  const data: Record<string, unknown> = {};
  if (forecastCategory) {
    data.sn_forecastcategory =
      FORECAST_CODES[forecastCategory as keyof typeof FORECAST_CODES];
  }
  if (closeDate) data.estimatedclosedate = closeDate;
  if (explicitQuarter) data.sn_closequarter = explicitQuarter;

  // H17 : close_date sans close_quarter -> on recalcule le trimestre.
  let quarterDerivation: { from: string; to: string; reason: string } | undefined;
  if (closeDate && !explicitQuarter) {
    const derived = quarterOfDate(closeDate);
    data.sn_closequarter = derived;
    quarterDerivation = {
      from: "close_date",
      to: derived,
      reason: "close_quarter was not supplied; recomputed from close_date so the deal is not counted in a stale quarter.",
    };
  }

  if (!Object.keys(data).length) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Nothing to update: provide at least one of forecast_category, close_date, close_quarter."
    );
  }

  const before = await getRecord("opportunities", opp.id, Object.keys(data));

  if (dryRun) {
    return {
      dry_run: true,
      opportunity_id: opp.id,
      opportunity_number: opp.number ?? null,
      diff: buildDiff(before, data),
      quarter_derivation: quarterDerivation,
      next_step: "Call again with dry_run=false to apply this diff.",
    };
  }

  await updateRecord("opportunities", opp.id, data, Object.keys(data));
  logMutation("update_opportunity_forecast", {
    opportunity: opp.number ?? opp.id,
    fields: data,
    diff: buildDiff(before, data),
  });

  const after = await getRecord("opportunities", opp.id, Object.keys(data));
  const check = verifyWrite(after, data);

  return {
    dry_run: false,
    opportunity_id: opp.id,
    opportunity_number: opp.number ?? null,
    written: true,
    verified: check.verified,
    mismatches: check.mismatches,
    quarter_derivation: quarterDerivation,
    read_back: after,
    warning: check.verified
      ? undefined
      : "Some fields were not applied — Dataverse may ignore read-only/calculated fields. See mismatches.",
  };
}

// ===========================================================================
// handlers exposés
// ===========================================================================
export const opportunityTools: ToolDef[] = [
  getMyOpportunitiesTool,
  searchOpportunitiesTool,
  getOpportunityProductsTool,
  getCollaborationNotesTool,
  addCollaborationNoteTool,
  addOpportunityProductTool,
  updateOpportunityForecastTool,
];

export const opportunityHandlers: Record<string, ToolHandler> = {
  get_my_opportunities: handleGetMyOpportunities,
  search_opportunities: handleSearchOpportunities,
  get_opportunity_products: handleGetOpportunityProducts,
  get_collaboration_notes: handleGetCollaborationNotes,
  add_collaboration_note: handleAddCollaborationNote,
  add_opportunity_product: handleAddOpportunityProduct,
  update_opportunity_forecast: handleUpdateOpportunityForecast,
};

export const FORECAST_WRITE_VALUES = FORECAST_WRITABLE;
export const STATUS_ENUM = STATUS_CHOICES;
export { STATE_OPEN };
export type { FilterSpec, ConditionSpec };