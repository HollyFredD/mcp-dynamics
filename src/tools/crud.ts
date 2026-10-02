import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  queryRecords,
  queryAll,
  queryAllFetchXml,
  getRecord,
  createRecord,
  updateRecord,
  deleteRecord,
  getEntityMetadata,
  listEntities,
  assertEntityWritable,
  assertEntityDeletable,
} from "../dataverse.js";
import { odataString, labelOf, fetchxmlValue } from "../odata.js";
import {
  MAX_PAGE_SIZE,
  DEFAULT_QUERY_ROWS,
  CACHE_TTL_MS,
} from "../constants.js";
import { cacheWrap } from "../cache.js";
import {
  bool,
  entityName,
  guidParam,
  intIn,
  record,
  requiredStr,
  str,
  strArray,
} from "../validate.js";
import { buildDiff, logMutation, verifyWrite } from "./common.js";

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const DRY_RUN_PROP = {
  dry_run: {
    type: "boolean",
    description:
      "When true (DEFAULT) nothing is written: the tool returns the exact diff it WOULD apply. Set false to actually write.",
  },
} as const;

const CONFIRM_PROP = {
  confirm: {
    type: "boolean",
    description:
      "Must be true to proceed. Deletion is irreversible and cannot be undone by this server.",
  },
} as const;

// ===========================================================================
// query_records
// ===========================================================================
const queryRecordsTool: ToolDef = {
  name: "query_records",
  description:
    "Query records from any Dynamics 365 entity using OData $filter syntax or FetchXML. Prefer a purpose-built tool (get_my_opportunities, get_forecast_summary, describe_entity_fields…) over a raw query. Always reports truncated / has_more / total_count.",
  inputSchema: {
    type: "object",
    properties: {
      entity: {
        type: "string",
        description: "Logical name of the entity, e.g. 'opportunities', 'accounts', 'contacts'",
      },
      filter: {
        type: "string",
        description: "OData $filter expression, e.g. \"name eq 'Acme'\" or \"statecode eq 0\"",
      },
      select: {
        type: "array",
        items: { type: "string" },
        description:
          "Fields to return as an ARRAY, e.g. ['name','estimatedclosedate','closeprobability']. Do not pass a comma-separated string.",
      },
      expand: {
        type: "array",
        items: { type: "string" },
        description: "Related entities to expand, e.g. ['parentaccountid($select=name)']",
      },
      orderby: { type: "string", description: "Sort expression, e.g. 'createdon desc'" },
      top: {
        type: "number",
        description: `Page size. Default ${DEFAULT_QUERY_ROWS}, max ${MAX_PAGE_SIZE}.`,
      },
      fetchxml: { type: "string", description: "FetchXML query (alternative to $filter)" },
      include_annotations: {
        type: "boolean",
        description:
          "Include OData annotations. Default false — annotations triple the payload size and waste context.",
      },
      fetch_all: {
        type: "boolean",
        description:
          "Follow pagination (@odata.nextLink for OData, incremented top for FetchXML) up to max_pages. Default false.",
      },
      max_pages: {
        type: "number",
        description: "Maximum number of pages when fetch_all is true (default 10).",
      },
      max_rows: {
        type: "number",
        description:
          "Hard cap on returned rows. Rows beyond the cap are dropped and reported via truncated=true.",
      },
    },
    required: ["entity"],
  },
};

async function handleQueryRecords(args: Record<string, unknown>): Promise<unknown> {
  const entity = entityName(args.entity);
  const select = strArray(args.select, "select", { max: 200, maxItems: 200 });
  const expand = strArray(args.expand, "expand", { max: 100, maxItems: 10 });
  const orderby = str(args.orderby, "orderby", { max: 200 });
  const filter = str(args.filter, "filter", { max: 4000 });
  const fetchxml = str(args.fetchxml, "fetchxml", { max: 100_000 });
  const includeAnnotations = bool(args.include_annotations, "include_annotations", false);
  const fetchAll = bool(args.fetch_all, "fetch_all", false);
  const top = intIn(args.top, "top", { def: DEFAULT_QUERY_ROWS, min: 1, max: MAX_PAGE_SIZE });
  const maxPages = intIn(args.max_pages, "max_pages", { def: 10, min: 1, max: 100 });
  const maxRows = intIn(args.max_rows, "max_rows", { def: undefined, min: 1, max: 100_000 });

  const base = {
    entity,
    filter,
    select,
    expand,
    orderby,
    fetchxml,
    include_annotations: includeAnnotations,
    count: true,
  };

  let rows: Record<string, unknown>[];
  let total: number | undefined;
  let truncated: boolean;
  let pages: number;
  let hasMore: boolean;
  /** true si `total` vient de $count (donc exact) et non d'un comptage local. */
  let countExact = false;

  if (fetchAll && fetchxml) {
    // Le FetchXML n'expose pas de @odata.nextLink : on incrémente `top`.
    const res = await queryAllFetchXml({
      entity,
      buildFetch: (t) => fetchxml!.replace(/top="\d+"/, `top="${t}"`),
      page_size: top,
      max_pages: maxPages,
      max_records: maxRows,
    });
    rows = res.value;
    total = res.total_records;
    truncated = res.truncated;
    pages = res.pages;
    hasMore = res.has_more;
  } else if (fetchAll) {
    const res = await queryAll({
      ...base,
      page_size: top,
      max_pages: maxPages,
      max_records: maxRows,
    });
    rows = res.value;
    total = res.total_records;
    truncated = res.truncated;
    pages = res.pages;
    hasMore = res.has_more;
    countExact = !fetchxml;
  } else {
    const res = await queryRecords({ ...base, top });
    rows = res.value;
    total = res["@odata.count"];
    countExact = total !== undefined;
    // Avec $count, on sait exactement s'il reste des pages.
    truncated = total !== undefined ? total > rows.length : rows.length >= top;
    pages = 1;
    hasMore = truncated;
  }

  let appliedMaxRows = maxRows;
  if (maxRows !== undefined && rows.length > maxRows) {
    rows = rows.slice(0, maxRows);
    truncated = true;
    hasMore = true;
  } else {
    appliedMaxRows = undefined;
  }

  return {
    entity,
    row_count: rows.length,
    total_count: total ?? null,
    truncated,
    has_more: hasMore,
    pages_fetched: pages,
    max_rows_applied: appliedMaxRows ?? null,
    count_exact: countExact,
    hint: !countExact && truncated
      ? `total_count is the number of rows actually read, NOT an exact total${
          fetchxml
            ? " (FetchXML cannot report a total count). Use fetch_all=true to page through everything, or aggregate_query for server-side totals."
            : "."
        }`
      : truncated
        ? "Some rows were not returned. Re-run with fetch_all=true (and a higher max_pages) or a lower filter to see everything."
        : undefined,
    records: rows,
  };
}

// ===========================================================================
// get_record
// ===========================================================================
const getRecordTool: ToolDef = {
  name: "get_record",
  description: "Get a single Dynamics 365 record by its ID (GUID).",
  inputSchema: {
    type: "object",
    properties: {
      entity: { type: "string", description: "Logical name of the entity" },
      id: { type: "string", description: "GUID of the record" },
      select: {
        type: "array",
        items: { type: "string" },
        description: "Fields to return as an ARRAY (optional, all fields if omitted)",
      },
    },
    required: ["entity", "id"],
  },
};

async function handleGetRecord(args: Record<string, unknown>): Promise<unknown> {
  const entity = entityName(args.entity);
  const id = guidParam(args.id, "id");
  const select = strArray(args.select, "select", { max: 200, maxItems: 200 });
  return { entity, id, record: await getRecord(entity, id, select) };
}

// ===========================================================================
// create_record
// ===========================================================================
const createRecordTool: ToolDef = {
  name: "create_record",
  description:
    `Create a record. RESTRICTED to the write allow-list (${"opportunities, opportunityproducts, sn_opportunitysubproductses, sn_activitycustomnoteses, tasks, notes, contacts, accounts"}). By default this is a DRY RUN: it returns what would be created. Pass dry_run=false to write. System entities (users, roles, settings, business units, teams) are refused.`,
  inputSchema: {
    type: "object",
    properties: {
      entity: { type: "string", description: "Logical name of the entity (must be allow-listed)" },
      data: {
        type: "object",
        description: "Field values for the new record",
        additionalProperties: true,
      },
      ...DRY_RUN_PROP,
    },
    required: ["entity", "data"],
  },
};

async function handleCreateRecord(args: Record<string, unknown>): Promise<unknown> {
  const entity = entityName(args.entity);
  const data = record(args.data, "data");
  const dryRun = bool(args.dry_run, "dry_run", true) ?? true;

  assertEntityWritable(entity);

  // Refus explicite des champs calculés / lecture seule les plus fréquents.
  const readOnly = Object.keys(data).filter((k) =>
    ["sn_probability", "modifiedon", "createdon", "opportunityid", "statecode"].includes(k)
  );
  if (readOnly.length) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Refusing to write read-only/calculated field(s): ${readOnly.join(", ")}. sn_probability is CALCULATED (string like "100%") and must never be written.`
    );
  }

  if (dryRun) {
    return {
      dry_run: true,
      entity,
      would_create: data,
      field_count: Object.keys(data).length,
      next_step: "Call again with dry_run=false to actually create the record.",
    };
  }

  const created = await createRecord(entity, data);
  logMutation("create_record", { entity, id: created.id, fields: Object.keys(data) });
  const reread = await getRecord(entity, created.id).catch(() => undefined);
  return {
    dry_run: false,
    entity,
    id: created.id,
    created: true,
    verified: reread ? Object.keys(reread).length > 0 : false,
    record: reread ?? created.representation,
  };
}

// ===========================================================================
// update_record
// ===========================================================================
const updateRecordTool: ToolDef = {
  name: "update_record",
  description:
    `Update fields on a record (write allow-list only). By default a DRY RUN returning the exact per-field diff. After writing, the record is RE-READ and the returned values are verified field by field, because Dataverse silently ignores read-only fields.`,
  inputSchema: {
    type: "object",
    properties: {
      entity: { type: "string", description: "Logical name of the entity" },
      id: { type: "string", description: "GUID of the record to update" },
      data: {
        type: "object",
        description: "Fields to update with their new values",
        additionalProperties: true,
      },
      ...DRY_RUN_PROP,
    },
    required: ["entity", "id", "data"],
  },
};

async function handleUpdateRecord(args: Record<string, unknown>): Promise<unknown> {
  const entity = entityName(args.entity);
  const id = guidParam(args.id, "id");
  const data = record(args.data, "data");
  const dryRun = bool(args.dry_run, "dry_run", true) ?? true;

  assertEntityWritable(entity);

  const readOnly = Object.keys(data).filter((k) =>
    ["sn_probability", "modifiedon", "createdon", "statecode", "sn_number"].includes(k)
  );
  if (readOnly.length) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Refusing to write read-only/calculated field(s): ${readOnly.join(", ")}.`
    );
  }

  const before = await getRecord(entity, id, Object.keys(data));

  if (dryRun) {
    return {
      dry_run: true,
      entity,
      id,
      diff: buildDiff(before, data),
      next_step: "Call again with dry_run=false to apply this diff.",
    };
  }

  await updateRecord(entity, id, data, Object.keys(data));
  logMutation("update_record", { entity, id, fields: Object.keys(data) });
  const after = await getRecord(entity, id, Object.keys(data));
  const check = verifyWrite(after, data);
  return {
    dry_run: false,
    entity,
    id,
    written: true,
    verified: check.verified,
    mismatches: check.mismatches,
    diff: buildDiff(before, data),
    read_back: after,
    warning: check.verified
      ? undefined
      : "Some fields were not applied — Dataverse ignores read-only/calculated fields. See mismatches.",
  };
}

// ===========================================================================
// delete_record
// ===========================================================================
const deleteRecordTool: ToolDef = {
  name: "delete_record",
  description:
    "Delete a record. IRREVERSIBLE. Requires confirm=true and an allow-listed entity. Permanently forbidden on systemusers, systemroles, roleassignments, systemsettings, businessunits, teams, usersettings, sn_specialistforecasts.",
  inputSchema: {
    type: "object",
    properties: {
      entity: { type: "string", description: "Logical name of the entity (must be allow-listed)" },
      id: { type: "string", description: "GUID of the record to delete" },
      ...CONFIRM_PROP,
      reason: { type: "string", description: "Optional free-text reason, logged to stderr" },
    },
    required: ["entity", "id", "confirm"],
  },
};

async function handleDeleteRecord(args: Record<string, unknown>): Promise<unknown> {
  const entity = entityName(args.entity);
  const id = guidParam(args.id, "id");
  const confirm = bool(args.confirm, "confirm", false);
  const reason = str(args.reason, "reason", { max: 500 });

  assertEntityDeletable(entity);

  if (confirm !== true) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Refusing to delete ${entity}(${id}) without explicit confirmation. Re-call with confirm=true (and optionally reason='…'). Deletion is irreversible.`
    );
  }

  await deleteRecord(entity, id);
  logMutation("delete_record", { entity, id, reason: reason ?? null });
  return { deleted: true, entity, id, reason: reason ?? null };
}

// ===========================================================================
// get_entity_metadata / list_entities
// ===========================================================================
const getEntityMetadataTool: ToolDef = {
  name: "get_entity_metadata",
  description:
    "Basic metadata for an entity: primary key, primary name field, label. For the full attribute list use describe_entity_fields.",
  inputSchema: {
    type: "object",
    properties: {
      entity: { type: "string", description: "Logical name of the entity, e.g. 'opportunities'" },
    },
    required: ["entity"],
  },
};

async function handleGetEntityMetadata(args: Record<string, unknown>): Promise<unknown> {
  const entity = entityName(args.entity);
  const meta = await getEntityMetadata(entity);
  const raw = meta as Record<string, unknown>;
  return {
    entity,
    logicalName: raw.LogicalName,
    displayName: labelOf(raw.DisplayCollectionName) ?? raw.LogicalName,
    entitySetName: raw.EntitySetName,
    primaryIdAttribute: raw.PrimaryIdAttribute,
    primaryNameAttribute: raw.PrimaryNameAttribute,
    isCustomEntity: raw.IsCustomEntity,
    raw,
  };
}

const listEntitiesTool: ToolDef = {
  name: "list_entities",
  description:
    "List available entities (bounded to 200, ordered by logical name). Returns has_more when truncated. Use describe_entity_fields to inspect an entity's attributes.",
  inputSchema: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description: "Substring filter on the logical name, e.g. 'forecast'",
      },
      only_custom: { type: "boolean", description: "Only custom (solution) entities (default false)" },
      top: { type: "number", description: "Maximum entities to return (default 200, max 1000)" },
    },
  },
};

async function handleListEntities(args: Record<string, unknown>): Promise<unknown> {
  const search = str(args.search, "search", { max: 64 });
  const onlyCustom = bool(args.only_custom, "only_custom", false);
  const top = intIn(args.top, "top", { def: 200, min: 1, max: 1000 });

  const res = await cacheWrap(`entities:${onlyCustom}:${search ?? ""}:${top}`, CACHE_TTL_MS, () =>
    listEntities({ search, onlyCustom, top, count: true })
  );

  return {
    entity_count: res.entities.length,
    total_count: res.total_count ?? null,
    truncated: res.has_more,
    has_more: res.has_more,
    entities: res.entities,
  };
}

// ===========================================================================
// describe_entity_fields (F1)
// ===========================================================================
const describeEntityFieldsTool: ToolDef = {
  name: "describe_entity_fields",
  description:
    "List the attributes of an entity with label, type, and whether they are custom / read-only / calculated / required. CALL THIS BEFORE writing any field: it is the reliable way to discover exact field names (e.g. search 'acv', 'probab', 'renewal', 'forecast'). Use list_picklist_values to decode option-set codes.",
  inputSchema: {
    type: "object",
    properties: {
      entity: {
        type: "string",
        description: "Logical name of the entity, e.g. 'opportunities', 'sn_specialistforecasts'",
      },
      search: {
        type: "string",
        description:
          "Case-insensitive substring filter on the attribute name or label, e.g. 'acv', 'probab', 'renewal', 'forecast'",
      },
      only_custom: {
        type: "boolean",
        description: "Only custom (solution) attributes (default false)",
      },
      include_readonly: {
        type: "boolean",
        description: "Include read-only / calculated attributes (default true)",
      },
    },
    required: ["entity"],
  },
};

interface AttributeMeta {
  LogicalName?: string;
  SchemaName?: string;
  AttributeType?: string;
  AttributeOf?: string;
  IsCustomAttribute?: boolean;
  IsValidForRead?: boolean;
  IsValidForWrite?: boolean;
  IsRequired?: boolean;
  IsCalculated?: boolean;
  IsPrimaryId?: boolean;
  MaxLength?: number;
  DisplayCollectionName?: unknown;
  OptionSet?: unknown;
}

async function handleDescribeEntityFields(args: Record<string, unknown>): Promise<unknown> {
  const entity = entityName(args.entity);
  const search = str(args.search, "search", { max: 64 })?.toLowerCase();
  const onlyCustom = bool(args.only_custom, "only_custom", false);
  const includeReadOnly = bool(args.include_readonly, "include_readonly", true);

  const payload = await cacheWrap(
    `attrs:${entity}`,
    CACHE_TTL_MS,
    async () => {
      const params = new URLSearchParams({
        $select:
          "LogicalName,SchemaName,AttributeType,AttributeOf,IsCustomAttribute,IsValidForRead,IsValidForWrite,IsRequired,IsCalculated,IsPrimaryId,MaxLength,DisplayCollectionName",
        $filter: `EntityLogicalName eq ${odataString(entity)}`,
      });
      const res = await fetchXmlAttributePage(
        `/EntityDefinitions(LogicalName=${odataString(entity)})/Attributes?${params.toString()}`
      );
      return res;
    }
  );

  const attrs = (payload as AttributeMeta[]).filter((a) => {
    if (onlyCustom && !a.IsCustomAttribute) return false;
    if (!includeReadOnly && (a.IsValidForWrite === false || a.IsCalculated)) return false;
    if (search) {
      const name = (a.LogicalName ?? "").toLowerCase();
      const label = (labelOf(a.DisplayCollectionName) ?? "").toLowerCase();
      if (!name.includes(search) && !label.includes(search)) return false;
    }
    return true;
  });

  return {
    entity,
    total_attributes: attrs.length,
    filters: {
      search: search ?? null,
      only_custom: onlyCustom,
      include_readonly: includeReadOnly,
    },
    fields: attrs.map((a) => ({
      name: a.LogicalName,
      schema_name: a.SchemaName,
      label: labelOf(a.DisplayCollectionName) ?? a.LogicalName,
      type: a.AttributeType,
      target: a.AttributeOf && a.AttributeOf !== "none" ? a.AttributeOf : undefined,
      is_custom: !!a.IsCustomAttribute,
      is_readonly: a.IsValidForWrite === false,
      is_calculated: !!a.IsCalculated,
      is_required: !!a.IsRequired,
      is_primary_id: !!a.IsPrimaryId,
      max_length: a.MaxLength ?? undefined,
    })),
  };
}

async function fetchXmlAttributePage(url: string): Promise<AttributeMeta[]> {
  const res = await rawGet<{ value: AttributeMeta[] }>(url);
  return res.value ?? [];
}

// ===========================================================================
// list_picklist_values (F2)
// ===========================================================================
const listPicklistValuesTool: ToolDef = {
  name: "list_picklist_values",
  description:
    "List the value/label pairs of a picklist (option set) or state/status code attribute. Use this to decode option-set codes such as sn_winlossnodecisionreason, sn_risktype, sn_salesstage or sn_forecastcategory.",
  inputSchema: {
    type: "object",
    properties: {
      entity: { type: "string", description: "Logical name of the entity, e.g. 'opportunities'" },
      attribute: {
        type: "string",
        description: "Logical name of the attribute, e.g. 'sn_forecastcategory'",
      },
    },
    required: ["entity", "attribute"],
  },
};

async function handleListPicklistValues(args: Record<string, unknown>): Promise<unknown> {
  const entity = entityName(args.entity);
  const attribute = requiredStr(args.attribute, "attribute", { max: 128 });
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(attribute)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid 'attribute': '${attribute}'. It must be a logical attribute name like 'sn_forecastcategory'.`
    );
  }

  return cacheWrap(`picklist:${entity}:${attribute}`, CACHE_TTL_MS, async () => {
    // 1) Attribut simple (statecode, statuscode…) : MetadataId -> OptionSet
    const simpleUrl =
      `/EntityDefinitions(LogicalName=${odataString(entity)})/Attributes(LogicalName=${odataString(attribute)})` +
      `?$select=LogicalName,AttributeType,OptionSet`;

    try {
      const meta = await rawGet<{
        OptionSet?: { Options?: { Value: number; Label?: unknown; Description?: unknown }[] };
        AttributeType?: string;
      }>(simpleUrl);
      const options = meta?.OptionSet?.Options ?? [];
      if (options.length) {
        return {
          entity,
          attribute,
          source: "AttributeMetadata/OptionSet",
          option_count: options.length,
          values: options.map((o) => ({
            value: o.Value,
            label: labelOf(o.Label) ?? String(o.Value),
            description: labelOf(o.Description),
          })),
        };
      }
    } catch {
      /* picklist multi-select ou attribut absent : on tente PicklistAttributeMetadata */
    }

    // 2) PicklistAttributeMetadata
    const picklistUrl =
      `/${entity}/Microsoft.Dynamics.CRM.PicklistAttributeMetadata` +
      `(LogicalName=${odataString(attribute)})` +
      `/OptionSet/Options?$select=Value,Label,Description`;

    const res = await rawGet<{
      value: { Value: number; Label?: unknown; Description?: unknown }[];
    }>(picklistUrl);

    const values = (res.value ?? []).map((o) => ({
      value: o.Value,
      label: labelOf(o.Label) ?? String(o.Value),
      description: labelOf(o.Description),
    }));

    if (!values.length) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No picklist options found for ${entity}.${attribute}. The attribute may be a plain string/number, or the name may be wrong. Call describe_entity_fields(entity='${entity}', search='${attribute.slice(0, 8)}') to verify.`
      );
    }

    return {
      entity,
      attribute,
      source: "PicklistAttributeMetadata/OptionSet",
      option_count: values.length,
      values,
    };
  });
}

// ===========================================================================
// aggregate_query (F6)
// ===========================================================================

const AGG_FNS = {
  sum: "sum",
  avg: "avg",
  min: "min",
  max: "max",
  count: "count",
  countdistinct: "countcolumn",
} as const;
export type AggFn = keyof typeof AGG_FNS;

const aggregateQueryTool: ToolDef = {
  name: "aggregate_query",
  description:
    "Server-side aggregation over any entity: group by up to 3 fields and compute sum/avg/min/max/count. Executes as a single FetchXML aggregate query, so it does NOT cap at a few hundred rows. Preferred over downloading rows and summing client-side.",
  inputSchema: {
    type: "object",
    properties: {
      entity: { type: "string", description: "Logical name of the entity" },
      groupby: {
        type: "array",
        items: { type: "string" },
        description:
          "Fields to group by, e.g. ['sn_closequarter']. Prefix a linked field with 'alias.attribute', e.g. 'opp.sn_forecastcategory'.",
      },
      measures: {
        type: "array",
        description: "Aggregations, e.g. [{field:'sn_productnnacv', fn:'sum'}]",
        items: {
          type: "object",
          properties: {
            field: { type: "string", description: "Numeric field to aggregate" },
            fn: {
              type: "string",
              enum: ["sum", "avg", "min", "max", "count", "countdistinct"],
              description: "Aggregation function (default: sum)",
            },
            as: { type: "string", description: "Alias for the result key (optional)" },
          },
          required: ["field"],
        },
      },
      filter: {
        type: "string",
        description:
          "Optional OData $filter applied to the entity BEFORE aggregation, e.g. \"statecode eq 0\"",
      },
      orderby: {
        type: "string",
        description: "Order on a group-by or measure alias, e.g. 'agg_sum_amount desc'",
      },
      top: { type: "number", description: "Maximum number of groups (default 200, max 5000)" },
    },
    required: ["entity", "measures"],
  },
};

function odataToFetchConditions(filter: string): string[] {
  // Traduction d'un sous-ensemble d'OData $filter en conditions FetchXML.
  const parts = filter.split(/\s+and\s+/i).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+(eq|neq|gt|geq|lt|leq)\s+(.+)$/i.exec(part);
    if (!m) continue; // sous-ensembles non supportés : ignorés silencieusement
    const [, attr, op, rawVal] = m;
    const value = rawVal.replace(/^'/, "").replace(/'$/, "").replace(/''/g, "'");
    out.push(`<condition attribute="${fetchxmlValue(attr)}" operator="${op.toLowerCase()}" value="${fetchxmlValue(value)}" />`);
  }
  return out;
}

async function handleAggregateQuery(args: Record<string, unknown>): Promise<unknown> {
  const entity = entityName(args.entity);
  const groupby = strArray(args.groupby, "groupby", { max: 128, maxItems: 3 }) ?? [];
  const top = intIn(args.top, "top", { def: 200, min: 1, max: 5000 });
  const filter = str(args.filter, "filter", { max: 2000 });
  const orderby = str(args.orderby, "orderby", { max: 200 });

  const rawMeasures = Array.isArray(args.measures) ? args.measures : [];
  if (!rawMeasures.length) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Missing required parameter 'measures': provide at least one aggregation, e.g. [{field:'sn_productnnacv', fn:'sum'}]."
    );
  }
  const measures = rawMeasures.map((m, i) => {
    if (!m || typeof m !== "object") {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid 'measures[${i}]': expected an object {field, fn}, received ${JSON.stringify(m)}.`
      );
    }
    const mo = m as Record<string, unknown>;
    const field = requiredStr(mo.field, `measures[${i}].field`, { max: 128 });
    const fn = oneOfAgg(mo.fn, i);
    const as = str(mo.as, `measures[${i}].as`, { max: 64 });
    const alias = as ?? `agg_${fn}_${field.replace(/\W+/g, "_")}`;
    return { field, fn, alias };
  });

  // Attributs de groupement puis mesures agrégées.
  const attrs: string[] = groupby.map(
    (g) =>
      `<attribute name="${fetchxmlValue(g)}" alias="${fetchxmlValue(
        `grp_${g.replace(/\W+/g, "_")}`
      )}" groupby="true" />`
  );
  for (const m of measures) {
    attrs.push(
      `<attribute name="${fetchxmlValue(m.field)}" alias="${fetchxmlValue(
        m.alias
      )}" aggregate="${AGG_FNS[m.fn]}" />`
    );
  }

  const filterBlock = filter
    ? `<filter type="and">${odataToFetchConditions(filter).join("")}</filter>`
    : "";
  const orderBlock = orderby
    ? `<order attribute="${fetchxmlValue(
        orderby.split(/\s+/)[0]
      )}" descending="${/\s+desc$/i.test(orderby) ? "true" : "false"}" />`
    : "";

  const body =
    `<fetch top="${top}">` +
    `<entity name="${fetchxmlValue(entity)}" aggregate="true">` +
    attrs.join("") +
    filterBlock +
    orderBlock +
    `</entity>` +
    `</fetch>`;

  const res = await queryRecords({ entity, fetchxml: body });
  return {
    entity,
    groupby,
    measures: measures.map((m) => ({ field: m.field, fn: m.fn, alias: m.alias })),
    group_count: res.value.length,
    truncated: res.value.length >= top,
    has_more: res.value.length >= top,
    groups: res.value,
  };
}

function oneOfAgg(v: unknown, index: number): AggFn {
  if (v === undefined || v === null || v === "") return "sum";
  const allowed = Object.keys(AGG_FNS);
  const s = String(v).trim().toLowerCase();
  const hit = allowed.find((a) => a === s);
  if (!hit) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid 'measures[${index}].fn': '${v}'. Allowed values: ${allowed
        .map((a) => `'${a}'`)
        .join(", ")}.`
    );
  }
  return hit as AggFn;
}

// ===========================================================================
// rawGet : petit utilitaire interne (métadonnées)
// ===========================================================================
async function rawGet<T>(path: string): Promise<T> {
  const mod = await import("../dataverse.js");
  const api = await mod.getClient();
  const { bumpDataverseCall } = await import("../log.js");
  bumpDataverseCall();
  const res = await api.request<T>({ method: "get", url: path });
  return res.data;
}

// ===========================================================================

export const crudTools: ToolDef[] = [
  queryRecordsTool,
  getRecordTool,
  createRecordTool,
  updateRecordTool,
  deleteRecordTool,
  getEntityMetadataTool,
  listEntitiesTool,
  describeEntityFieldsTool,
  listPicklistValuesTool,
  aggregateQueryTool,
];

export const crudHandlers: Record<string, ToolHandler> = {
  query_records: handleQueryRecords,
  get_record: handleGetRecord,
  create_record: handleCreateRecord,
  update_record: handleUpdateRecord,
  delete_record: handleDeleteRecord,
  get_entity_metadata: handleGetEntityMetadata,
  list_entities: handleListEntities,
  describe_entity_fields: handleDescribeEntityFields,
  list_picklist_values: handleListPicklistValues,
  aggregate_query: handleAggregateQuery,
};