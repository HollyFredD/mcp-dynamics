import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { queryRecords, getRecord, createRecord, updateRecord, deleteRecord, getEntityMetadata, listEntities, resolveUserGuid, } from "../dataverse.js";
const COLLAB_NOTE_TYPES = {
    "Next Steps": 876130002,
    "Win/Loss": 876130000,
    "General": 876130001,
};
async function resolveOpportunityId(opportunityId, opportunityNumber) {
    if (opportunityId)
        return opportunityId;
    if (!opportunityNumber)
        throw new Error("Either opportunity_id or opportunity_number is required.");
    const result = await queryRecords({
        entity: "opportunities",
        filter: `sn_number eq '${opportunityNumber}'`,
        select: ["opportunityid"],
        top: 1,
    });
    const record = result.value[0];
    if (!record)
        throw new Error(`Opportunity not found: ${opportunityNumber}`);
    return record["opportunityid"];
}
function formatError(err) {
    if (axios_isAxiosError(err)) {
        const msg = err
            .response?.data?.error?.message ?? err.message;
        return msg;
    }
    return err instanceof Error ? err.message : String(err);
}
function axios_isAxiosError(err) {
    return typeof err === "object" && err !== null && "isAxiosError" in err;
}
export const recordTools = [
    {
        name: "query_records",
        description: "Query records from any Dynamics 365 entity. Use OData $filter syntax or FetchXML. Returns up to 50 records by default.",
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
                    description: "Fields to return, e.g. ['name', 'estimatedvalue', 'statecode']",
                },
                expand: {
                    type: "array",
                    items: { type: "string" },
                    description: "Related entities to expand, e.g. ['parentaccountid($select=name)']",
                },
                orderby: {
                    type: "string",
                    description: "Sort expression, e.g. 'createdon desc'",
                },
                top: {
                    type: "number",
                    description: "Maximum number of records to return (default 50, max 1000)",
                },
                fetchxml: {
                    type: "string",
                    description: "FetchXML query string (alternative to OData filter)",
                },
            },
            required: ["entity"],
        },
    },
    {
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
                    description: "Fields to return (optional, returns all if omitted)",
                },
            },
            required: ["entity", "id"],
        },
    },
    {
        name: "create_record",
        description: "Create a new record in any Dynamics 365 entity. Returns the new record's ID.",
        inputSchema: {
            type: "object",
            properties: {
                entity: { type: "string", description: "Logical name of the entity" },
                data: {
                    type: "object",
                    description: "Field values for the new record",
                    additionalProperties: true,
                },
            },
            required: ["entity", "data"],
        },
    },
    {
        name: "update_record",
        description: "Update fields on an existing Dynamics 365 record.",
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
            },
            required: ["entity", "id", "data"],
        },
    },
    {
        name: "delete_record",
        description: "Delete a Dynamics 365 record. Use with caution — this is irreversible.",
        inputSchema: {
            type: "object",
            properties: {
                entity: { type: "string", description: "Logical name of the entity" },
                id: { type: "string", description: "GUID of the record to delete" },
            },
            required: ["entity", "id"],
        },
    },
    {
        name: "get_entity_metadata",
        description: "Get metadata for a Dynamics 365 entity: primary key, primary name field, and basic info. Useful to understand the structure before querying.",
        inputSchema: {
            type: "object",
            properties: {
                entity: { type: "string", description: "Logical name of the entity, e.g. 'opportunity'" },
            },
            required: ["entity"],
        },
    },
    {
        name: "list_entities",
        description: "List all available entities (tables) in the Dynamics 365 instance.",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "get_my_opportunities",
        description: "Get opportunities associated with a user by role (owner, field sales rep, solution consultant, etc.). Defaults to the currently authenticated Azure CLI user. Supports filtering by status, forecast category, close quarter, and role.",
        inputSchema: {
            type: "object",
            properties: {
                email: {
                    type: "string",
                    description: "Email of the user to look up (defaults to the currently authenticated Azure CLI user if omitted)",
                },
                role: {
                    type: "string",
                    enum: ["owner", "field_sales_rep", "solution_consultant", "secondary_sales_rep", "renewal_account_manager", "any"],
                    description: "Which role field to filter by. 'any' checks all role fields simultaneously (default: 'any')",
                },
                status: {
                    type: "string",
                    enum: ["open", "won", "lost", "all"],
                    description: "Filter by opportunity status (default: 'open')",
                },
                forecast_category: {
                    type: "string",
                    enum: ["pipeline", "best_case", "committed", "upside", "closed", "all"],
                    description: "Filter by SN forecast category",
                },
                close_quarter: {
                    type: "string",
                    description: "Filter by close quarter, e.g. '25-Q3' or '26-Q1'",
                },
                top: {
                    type: "number",
                    description: "Maximum number of records to return (default: 50)",
                },
            },
        },
    },
    {
        name: "get_opportunity_products",
        description: "Get the product lines (SKUs) of a Dynamics 365 opportunity from the opportunityproducts entity. Each row is a product line item with its name, business unit (Security, Risk, ITSM…), net new ACV, annual rate, start date, and currency. Use this to see WHAT is being sold on an opportunity. Do NOT use this to get specialist forecasts — use get_specialist_opportunities for that. Accepts either the opportunity GUID or its number (e.g. 'OPTY5331870').",
        inputSchema: {
            type: "object",
            properties: {
                opportunity_id: {
                    type: "string",
                    description: "GUID of the opportunity (use this or opportunity_number)",
                },
                opportunity_number: {
                    type: "string",
                    description: "Opportunity number like 'OPTY5331870' (use this or opportunity_id)",
                },
            },
        },
    },
    {
        name: "get_collaboration_notes",
        description: "Get Collaboration Notes for a Dynamics 365 opportunity. Accepts either the opportunity GUID or its number (e.g. 'OPTY5331870'). Returns notes sorted by most recent first.",
        inputSchema: {
            type: "object",
            properties: {
                opportunity_id: {
                    type: "string",
                    description: "GUID of the opportunity (use this or opportunity_number)",
                },
                opportunity_number: {
                    type: "string",
                    description: "Opportunity number like 'OPTY5331870' (use this or opportunity_id)",
                },
                note_type: {
                    type: "string",
                    enum: ["Next Steps", "Win/Loss", "General"],
                    description: "Filter by note type (optional, returns all types if omitted)",
                },
                top: {
                    type: "number",
                    description: "Maximum number of notes to return (default: 20)",
                },
            },
        },
    },
    {
        name: "get_specialist_opportunities",
        description: "Get the specialist forecast records (sn_specialistforecasts entity) for a given specialist (Solution Sales Executive). Each row is a specialist forecast assignment — it shows the specialist's allocated ACV (sn_productnnacv), their forecast category, and the linked opportunity. This is NOT the list of product lines on an opportunity: use get_opportunity_products for that. Use this tool to retrieve a specialist's pipeline filtered by their assigned business units (e.g. Security, Risk, Impact) and optionally by close quarter or opportunity status.",
        inputSchema: {
            type: "object",
            properties: {
                email: {
                    type: "string",
                    description: "Email of the specialist (defaults to the currently authenticated Azure CLI user if omitted)",
                },
                business_units: {
                    type: "array",
                    items: { type: "string" },
                    description: "Business unit names to filter on, e.g. ['Security', 'Risk', 'Impact']. Leave empty to return all BUs.",
                },
                close_quarter: {
                    type: "string",
                    description: "Filter by close quarter on the opportunity, e.g. '26-Q2' or '26-Q3'",
                },
                status: {
                    type: "string",
                    enum: ["open", "won", "lost", "all"],
                    description: "Filter by opportunity status (default: 'all')",
                },
                top: {
                    type: "number",
                    description: "Maximum number of records to return (default: 100)",
                },
            },
        },
    },
    {
        name: "add_opportunity_product",
        description: "Add a product line and its sub-product to a Dynamics 365 opportunity. Provide the parent forecast name (e.g. 'Security Forecast') and the sub-product name (e.g. 'Veza Forecast' or just 'Veza'). If a parent product line already exists on the opportunity, the sub-product is attached to it; otherwise a new parent line is created. Accepts either the opportunity GUID or its number (e.g. 'OPTY5331870').",
        inputSchema: {
            type: "object",
            properties: {
                opportunity_id: {
                    type: "string",
                    description: "GUID of the opportunity (use this or opportunity_number)",
                },
                opportunity_number: {
                    type: "string",
                    description: "Opportunity number like 'OPTY5331870' (use this or opportunity_id)",
                },
                product_name: {
                    type: "string",
                    description: "Name or partial name of the parent forecast product, e.g. 'Security Forecast' or 'Security'",
                },
                sub_product_name: {
                    type: "string",
                    description: "Name or partial name of the sub-product, e.g. 'Veza Forecast' or 'Veza'",
                },
                nnacv: {
                    type: "number",
                    description: "Net New Annual Contract Value for this sub-product line",
                },
                currency: {
                    type: "string",
                    description: "ISO currency code, e.g. 'EUR' or 'USD' (default: EUR)",
                },
                start_date: {
                    type: "string",
                    description: "Start date for the product line in YYYY-MM-DD format (optional)",
                },
            },
            required: ["product_name", "sub_product_name", "nnacv"],
        },
    },
    {
        name: "add_collaboration_note",
        description: "Add a Collaboration Note to a Dynamics 365 opportunity. Accepts either the opportunity GUID or its number (e.g. 'OPTY5331870').",
        inputSchema: {
            type: "object",
            properties: {
                opportunity_id: {
                    type: "string",
                    description: "GUID of the opportunity (use this or opportunity_number)",
                },
                opportunity_number: {
                    type: "string",
                    description: "Opportunity number like 'OPTY5331870' (use this or opportunity_id)",
                },
                note: {
                    type: "string",
                    description: "Text content of the collaboration note",
                },
                note_type: {
                    type: "string",
                    enum: ["Next Steps", "Win/Loss", "General"],
                    description: "Type of note (default: 'Next Steps')",
                },
                subject: {
                    type: "string",
                    description: "Subject line (auto-derived from note if omitted)",
                },
            },
            required: ["note"],
        },
    },
    {
        name: "get_forecast_summary",
        description: "Get an aggregated forecast summary for a specialist by quarter: total ACV and deal count per forecast category (committed, best_case, upside, pipeline), broken down by business unit. Primary tool to prepare for weekly forecast calls.",
        inputSchema: {
            type: "object",
            properties: {
                close_quarter: {
                    type: "string",
                    description: "Quarter to summarize, e.g. '26-Q2' or '26-Q3'",
                },
                email: {
                    type: "string",
                    description: "Specialist email (defaults to authenticated user)",
                },
                business_units: {
                    type: "array",
                    items: { type: "string" },
                    description: "Filter by BU names, e.g. ['Security', 'Risk']. Returns all BUs if omitted.",
                },
            },
            required: ["close_quarter"],
        },
    },
    {
        name: "update_opportunity_forecast",
        description: "Update the forecast category, close date, or close quarter on an opportunity. Use during pipeline reviews to move deals between categories or push out close dates. Accepts either the opportunity GUID or its number (e.g. 'OPTY5331870').",
        inputSchema: {
            type: "object",
            properties: {
                opportunity_id: {
                    type: "string",
                    description: "GUID of the opportunity (use this or opportunity_number)",
                },
                opportunity_number: {
                    type: "string",
                    description: "Opportunity number like 'OPTY5331870' (use this or opportunity_id)",
                },
                forecast_category: {
                    type: "string",
                    enum: ["pipeline", "best_case", "committed", "upside"],
                    description: "New forecast category",
                },
                close_date: {
                    type: "string",
                    description: "New close date in YYYY-MM-DD format",
                },
                close_quarter: {
                    type: "string",
                    description: "New close quarter, e.g. '26-Q3'",
                },
            },
        },
    },
    {
        name: "update_specialist_forecast",
        description: "Update the forecast category on a specialist forecast record (sn_specialistforecast). Finds the record by opportunity and optionally by business unit. Use to change your committed/best_case/upside/pipeline classification at the specialist level, independently from the opportunity-level forecast.",
        inputSchema: {
            type: "object",
            properties: {
                opportunity_id: {
                    type: "string",
                    description: "GUID of the opportunity (use this or opportunity_number)",
                },
                opportunity_number: {
                    type: "string",
                    description: "Opportunity number like 'OPTY5331870' (use this or opportunity_id)",
                },
                forecast_category: {
                    type: "string",
                    enum: ["pipeline", "best_case", "committed", "upside"],
                    description: "New forecast category for the specialist forecast record",
                },
                business_unit: {
                    type: "string",
                    description: "BU name to disambiguate if multiple specialist forecasts exist for the same opportunity, e.g. 'Security'",
                },
                email: {
                    type: "string",
                    description: "Specialist email (defaults to authenticated user)",
                },
            },
            required: ["forecast_category"],
        },
    },
    {
        name: "get_at_risk_deals",
        description: "Get open deals that need attention before a forecast call: overdue (past close date), stale (not updated in X days), or misaligned (committed/best_case with probability below 30%). Checks all three risk types by default.",
        inputSchema: {
            type: "object",
            properties: {
                email: {
                    type: "string",
                    description: "User email (defaults to authenticated user)",
                },
                close_quarter: {
                    type: "string",
                    description: "Restrict to a specific close quarter, e.g. '26-Q2'",
                },
                stale_days: {
                    type: "number",
                    description: "Flag deals not modified in this many days (default: 30)",
                },
                include_overdue: {
                    type: "boolean",
                    description: "Include deals with a past close date (default: true)",
                },
                include_stale: {
                    type: "boolean",
                    description: "Include deals not updated recently (default: true)",
                },
                include_misaligned: {
                    type: "boolean",
                    description: "Include committed/best_case deals with probability below 30% (default: true)",
                },
            },
        },
    },
    {
        name: "search_opportunities",
        description: "Search opportunities by name or account name. Returns key forecast fields. Useful for quick lookups without writing OData filters.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Search term matched against opportunity name and account name",
                },
                status: {
                    type: "string",
                    enum: ["open", "won", "lost", "all"],
                    description: "Filter by opportunity status (default: open)",
                },
                close_quarter: {
                    type: "string",
                    description: "Optionally restrict to a specific close quarter, e.g. '26-Q3'",
                },
                top: {
                    type: "number",
                    description: "Max number of results (default: 15)",
                },
            },
            required: ["query"],
        },
    },
];
export async function handleRecordTool(name, args) {
    try {
        let result;
        switch (name) {
            case "query_records": {
                const { entity, filter, select, expand, orderby, top, fetchxml } = args;
                result = await queryRecords({
                    entity,
                    filter,
                    select,
                    expand,
                    orderby,
                    top: top ?? 50,
                    fetchxml,
                });
                break;
            }
            case "get_record": {
                const { entity, id, select } = args;
                result = await getRecord(entity, id, select);
                break;
            }
            case "create_record": {
                const { entity, data } = args;
                const newId = await createRecord(entity, data);
                result = { id: newId, message: `Record created with ID: ${newId}` };
                break;
            }
            case "update_record": {
                const { entity, id, data } = args;
                await updateRecord(entity, id, data);
                result = { message: `Record ${id} updated successfully` };
                break;
            }
            case "delete_record": {
                const { entity, id } = args;
                await deleteRecord(entity, id);
                result = { message: `Record ${id} deleted successfully` };
                break;
            }
            case "get_entity_metadata": {
                const { entity } = args;
                result = await getEntityMetadata(entity);
                break;
            }
            case "list_entities": {
                result = await listEntities();
                break;
            }
            case "get_my_opportunities": {
                const { email, role, status, forecast_category, close_quarter, top } = args;
                const userGuid = await resolveUserGuid(email);
                const ROLE_FIELDS = {
                    owner: "_ownerid_value",
                    field_sales_rep: "_sn_fieldsalesrep_value",
                    solution_consultant: "_sn_solutionconsultant_value",
                    secondary_sales_rep: "_sn_secondarysalesrep_value",
                    renewal_account_manager: "_sn_renewalaccountmanager_value",
                };
                const roleFilter = (role && role !== "any")
                    ? `${ROLE_FIELDS[role]} eq '${userGuid}'`
                    : Object.values(ROLE_FIELDS).map((f) => `${f} eq '${userGuid}'`).join(" or ");
                const filters = [`(${roleFilter})`];
                const STATUS_CODES = { open: 0, won: 1, lost: 2 };
                if (status && status !== "all") {
                    filters.push(`statecode eq ${STATUS_CODES[status]}`);
                }
                const FORECAST_CODES = {
                    pipeline: 876130000,
                    best_case: 876130001,
                    committed: 876130002,
                    closed: 876130003,
                    upside: 876130006,
                };
                if (forecast_category && forecast_category !== "all") {
                    filters.push(`sn_forecastcategory eq ${FORECAST_CODES[forecast_category]}`);
                }
                if (close_quarter) {
                    filters.push(`sn_closequarter eq '${close_quarter}'`);
                }
                result = await queryRecords({
                    entity: "opportunities",
                    filter: filters.join(" and "),
                    select: [
                        "name", "sn_number", "sn_salesstage", "sn_forecastcategory",
                        "estimatedclosedate", "sn_netnewacv", "sn_renewalacv", "sn_totalvalue",
                        "statecode", "statuscode", "sn_closequarter", "sn_opportunitytype",
                        "sn_opportunitybulist", "sn_channeltransactiontype",
                        "_customerid_value", "_ownerid_value", "_sn_fieldsalesrep_value",
                        "_sn_solutionconsultant_value", "sn_probability",
                    ],
                    orderby: "estimatedclosedate asc",
                    top: top ?? 50,
                });
                break;
            }
            case "get_opportunity_products": {
                const { opportunity_id, opportunity_number } = args;
                const oppId = await resolveOpportunityId(opportunity_id, opportunity_number);
                result = await queryRecords({
                    entity: "opportunityproducts",
                    fetchxml: `<fetch>
  <entity name="opportunityproduct">
    <attribute name="opportunityproductname"/>
    <attribute name="productname"/>
    <attribute name="sn_productbusinessunitid"/>
    <attribute name="sn_netnewannualcontractvalue"/>
    <attribute name="extendedamount"/>
    <attribute name="sn_annualrateamount"/>
    <attribute name="quantity"/>
    <attribute name="priceperunit"/>
    <attribute name="sn_startdateopportunityproduct"/>
    <attribute name="sn_renewalacv"/>
    <attribute name="sn_opportunitylinedefaultmetric"/>
    <attribute name="sequencenumber"/>
    <attribute name="transactioncurrencyid"/>
    <filter>
      <condition attribute="opportunityid" operator="eq" value="${oppId}"/>
    </filter>
    <order attribute="sequencenumber" descending="false"/>
  </entity>
</fetch>`,
                });
                break;
            }
            case "get_collaboration_notes": {
                const { opportunity_id, opportunity_number, note_type, top } = args;
                const oppId = await resolveOpportunityId(opportunity_id, opportunity_number);
                const filters = [`_regardingobjectid_value eq '${oppId}'`];
                if (note_type) {
                    filters.push(`sn_activitynotetype eq ${COLLAB_NOTE_TYPES[note_type]}`);
                }
                result = await queryRecords({
                    entity: "sn_activitycustomnoteses",
                    filter: filters.join(" and "),
                    select: ["subject", "sn_activitycustomnotes", "sn_activitynotetype", "createdon", "_createdby_value"],
                    orderby: "createdon desc",
                    top: top ?? 20,
                });
                break;
            }
            case "get_specialist_opportunities": {
                const { email, business_units, close_quarter, status, top } = args;
                const userGuid = await resolveUserGuid(email);
                const STATUS_CODES = { open: 0, won: 1, lost: 2 };
                const oppFilters = [];
                if (close_quarter) {
                    oppFilters.push(`<condition attribute="sn_closequarter" operator="eq" value="${close_quarter}"/>`);
                }
                if (status && status !== "all") {
                    oppFilters.push(`<condition attribute="statecode" operator="eq" value="${STATUS_CODES[status]}"/>`);
                }
                const oppFilterBlock = oppFilters.length
                    ? `<filter type="and">${oppFilters.join("")}</filter>`
                    : "";
                const hasBuFilter = business_units && business_units.length > 0;
                const buConditions = hasBuFilter
                    ? `<filter type="or">${business_units.map((bu) => `<condition attribute="sn_name" operator="eq" value="${bu}"/>`).join("")}</filter>`
                    : "";
                const buJoinType = hasBuFilter ? "inner" : "left-outer";
                const fetchxml = `<fetch top="${top ?? 100}">
  <entity name="sn_specialistforecast">
    <attribute name="sn_specialistforecastid"/>
    <attribute name="sn_forecasttype"/>
    <attribute name="sn_specialistforecastcategory"/>
    <attribute name="sn_specialistforecastcategoryreporting"/>
    <attribute name="sn_productnnacv"/>
    <attribute name="sn_specialistnnacvreporting"/>
    <attribute name="statecode"/>
    <filter type="and">
      <condition attribute="ownerid" operator="eq" value="${userGuid}"/>
    </filter>
    <link-entity name="sn_productbusinessunit" from="sn_productbusinessunitid" to="sn_businessunit" link-type="${buJoinType}" alias="bu">
      <attribute name="sn_name"/>
      ${buConditions}
    </link-entity>
    <link-entity name="opportunity" from="opportunityid" to="sn_opportunity" link-type="inner" alias="opp">
      <attribute name="name"/>
      <attribute name="sn_number"/>
      <attribute name="sn_closequarter"/>
      <attribute name="sn_salesstage"/>
      <attribute name="sn_forecastcategory"/>
      <attribute name="sn_netnewacv"/>
      <attribute name="sn_totalvalue"/>
      <attribute name="statecode"/>
      <attribute name="estimatedclosedate"/>
      <attribute name="sn_probability"/>
      <attribute name="sn_opportunitybulist"/>
      ${oppFilterBlock}
    </link-entity>
    <order attribute="sn_productnnacv" descending="true"/>
  </entity>
</fetch>`;
                result = await queryRecords({
                    entity: "sn_specialistforecasts",
                    fetchxml,
                });
                break;
            }
            case "add_opportunity_product": {
                const { opportunity_id, opportunity_number, product_name, sub_product_name, nnacv, currency, start_date } = args;
                const oppId = await resolveOpportunityId(opportunity_id, opportunity_number);
                // 1. Find parent product by name
                const productSearch = await queryRecords({
                    entity: "products",
                    filter: `contains(name, '${product_name}') and statecode eq 0`,
                    select: ["productid", "name"],
                    top: 5,
                });
                if (!productSearch.value.length)
                    throw new Error(`No active product found matching: ${product_name}`);
                const product = productSearch.value[0];
                const productId = product.productid;
                // 2. Find sub-product under that parent
                const subProductSearch = await queryRecords({
                    entity: "sn_subproducts",
                    fetchxml: `<fetch top="5">
  <entity name="sn_subproduct">
    <attribute name="sn_subproductid"/>
    <attribute name="sn_name"/>
    <filter>
      <condition attribute="sn_name" operator="like" value="%${sub_product_name}%"/>
      <condition attribute="sn_parentproduct" operator="eq" value="${productId}"/>
      <condition attribute="statecode" operator="eq" value="0"/>
    </filter>
  </entity>
</fetch>`,
                });
                if (!subProductSearch.value.length) {
                    throw new Error(`No sub-product found matching '${sub_product_name}' under ${product.name}`);
                }
                const subProduct = subProductSearch.value[0];
                const subProductId = subProduct.sn_subproductid;
                // 3. Find or create parent opportunityproduct line
                const existingLine = await queryRecords({
                    entity: "opportunityproducts",
                    filter: `_opportunityid_value eq '${oppId}' and _productid_value eq '${productId}'`,
                    select: ["opportunityproductid", "extendedamount"],
                    top: 1,
                });
                const PRIMARY_UNIT_ID = "93c725cf-309d-4ce2-b301-c62da5add0ed";
                let oppProductId;
                let parentAmount;
                if (existingLine.value.length) {
                    oppProductId = existingLine.value[0].opportunityproductid;
                    parentAmount = existingLine.value[0].extendedamount ?? nnacv;
                }
                else {
                    const lineData = {
                        "opportunityid@odata.bind": `/opportunities(${oppId})`,
                        "productid@odata.bind": `/products(${productId})`,
                        "uomid@odata.bind": `/uoms(${PRIMARY_UNIT_ID})`,
                        ispriceoverridden: true,
                        priceperunit: nnacv,
                        quantity: 1,
                        sn_netnewannualcontractvalue: nnacv,
                    };
                    if (start_date)
                        lineData.sn_startdateopportunityproduct = start_date;
                    oppProductId = await createRecord("opportunityproducts", lineData);
                    parentAmount = nnacv;
                }
                // 4. Resolve currency
                const CURRENCY_GUIDS = {
                    EUR: "0898499a-8c89-e911-a83e-000d3a1781be",
                    USD: "49af6d94-5c58-e911-a963-000d3a4e898a",
                };
                const currencyCode = (currency ?? "EUR").toUpperCase();
                const currencyId = CURRENCY_GUIDS[currencyCode];
                if (!currencyId)
                    throw new Error(`Unsupported currency: ${currencyCode}. Supported: EUR, USD.`);
                const percentage = parentAmount > 0 ? Math.round((nnacv / parentAmount) * 100) : 100;
                // 5. Create sub-product line
                const subProductLineId = await createRecord("sn_opportunitysubproductses", {
                    "sn_subproduct@odata.bind": `/sn_subproducts(${subProductId})`,
                    "sn_opportunity@odata.bind": `/opportunities(${oppId})`,
                    "sn_opportunityproduct@odata.bind": `/opportunityproducts(${oppProductId})`,
                    sn_amount: nnacv,
                    sn_percentage: percentage,
                    sn_opportunityproductamount: parentAmount,
                    "transactioncurrencyid@odata.bind": `/transactioncurrencies(${currencyId})`,
                    sn_currencycode: currencyCode,
                });
                result = {
                    message: `Added ${subProduct.sn_name} (${currencyCode} ${nnacv.toLocaleString()}) under ${product.name}`,
                    parentProductLine: { id: oppProductId, reused: existingLine.value.length > 0 },
                    subProductLine: { id: subProductLineId },
                };
                break;
            }
            case "add_collaboration_note": {
                const { opportunity_id, opportunity_number, note, note_type, subject } = args;
                const oppId = await resolveOpportunityId(opportunity_id, opportunity_number);
                const noteTypeValue = COLLAB_NOTE_TYPES[note_type ?? "Next Steps"] ?? COLLAB_NOTE_TYPES["Next Steps"];
                const derivedSubject = subject ?? note.slice(0, 100) + (note.length > 100 ? "..." : "");
                const newId = await createRecord("sn_activitycustomnoteses", {
                    subject: derivedSubject,
                    sn_activitycustomnotes: note,
                    sn_activitynotetype: noteTypeValue,
                    "regardingobjectid_opportunity_sn_activitycustomnotes@odata.bind": `/opportunities(${oppId})`,
                });
                result = { id: newId, message: `Collaboration note added to opportunity ${opportunity_number ?? oppId}` };
                break;
            }
            case "get_forecast_summary": {
                const { close_quarter, email, business_units } = args;
                const userGuid = await resolveUserGuid(email);
                const hasBuFilter = business_units && business_units.length > 0;
                const buConditions = hasBuFilter
                    ? `<filter type="or">${business_units.map((bu) => `<condition attribute="sn_name" operator="eq" value="${bu}"/>`).join("")}</filter>`
                    : "";
                const buJoinType = hasBuFilter ? "inner" : "left-outer";
                const fetchxml = `<fetch top="500">
  <entity name="sn_specialistforecast">
    <attribute name="sn_specialistforecastid"/>
    <attribute name="sn_specialistforecastcategory"/>
    <attribute name="sn_productnnacv"/>
    <filter type="and">
      <condition attribute="ownerid" operator="eq" value="${userGuid}"/>
      <condition attribute="statecode" operator="eq" value="0"/>
    </filter>
    <link-entity name="sn_productbusinessunit" from="sn_productbusinessunitid" to="sn_businessunit" link-type="${buJoinType}" alias="bu">
      <attribute name="sn_name"/>
      ${buConditions}
    </link-entity>
    <link-entity name="opportunity" from="opportunityid" to="sn_opportunity" link-type="inner" alias="opp">
      <attribute name="name"/>
      <attribute name="sn_number"/>
      <attribute name="sn_closequarter"/>
      <attribute name="estimatedclosedate"/>
      <attribute name="sn_salesstage"/>
      <filter type="and">
        <condition attribute="sn_closequarter" operator="eq" value="${close_quarter}"/>
        <condition attribute="statecode" operator="eq" value="0"/>
      </filter>
    </link-entity>
  </entity>
</fetch>`;
                const raw = await queryRecords({ entity: "sn_specialistforecasts", fetchxml });
                const CATEGORY_LABELS = {
                    876130002: "committed",
                    876130001: "best_case",
                    876130006: "upside",
                    876130000: "pipeline",
                    876130003: "closed",
                };
                const byCategory = {};
                const byBU = {};
                let totalACV = 0;
                for (const row of raw.value) {
                    const catCode = row.sn_specialistforecastcategory;
                    const cat = CATEGORY_LABELS[catCode] ?? `unknown_${catCode}`;
                    const acv = row.sn_productnnacv ?? 0;
                    const oppNumber = row["opp.sn_number"] ?? "";
                    const bu = row["bu.sn_name"] ?? "Unknown";
                    if (!byCategory[cat])
                        byCategory[cat] = { acv: 0, count: 0, deals: [] };
                    byCategory[cat].acv += acv;
                    byCategory[cat].count += 1;
                    if (oppNumber && !byCategory[cat].deals.includes(oppNumber))
                        byCategory[cat].deals.push(oppNumber);
                    if (!byBU[bu])
                        byBU[bu] = {};
                    if (!byBU[bu][cat])
                        byBU[bu][cat] = { acv: 0, count: 0 };
                    byBU[bu][cat].acv += acv;
                    byBU[bu][cat].count += 1;
                    totalACV += acv;
                }
                result = {
                    quarter: close_quarter,
                    total_acv: totalACV,
                    total_records: raw.value.length,
                    by_category: byCategory,
                    by_business_unit: byBU,
                };
                break;
            }
            case "update_opportunity_forecast": {
                const { opportunity_id, opportunity_number, forecast_category, close_date, close_quarter } = args;
                const oppId = await resolveOpportunityId(opportunity_id, opportunity_number);
                const FORECAST_CODES = {
                    pipeline: 876130000,
                    best_case: 876130001,
                    committed: 876130002,
                    upside: 876130006,
                };
                const data = {};
                if (forecast_category)
                    data.sn_forecastcategory = FORECAST_CODES[forecast_category];
                if (close_date)
                    data.estimatedclosedate = close_date;
                if (close_quarter)
                    data.sn_closequarter = close_quarter;
                if (Object.keys(data).length === 0) {
                    throw new Error("Provide at least one of: forecast_category, close_date, close_quarter.");
                }
                await updateRecord("opportunities", oppId, data);
                result = {
                    message: `Opportunity ${opportunity_number ?? oppId} updated successfully`,
                    changes: data,
                };
                break;
            }
            case "update_specialist_forecast": {
                const { opportunity_id, opportunity_number, forecast_category, business_unit, email } = args;
                const oppId = await resolveOpportunityId(opportunity_id, opportunity_number);
                const userGuid = await resolveUserGuid(email);
                const FORECAST_CODES = {
                    pipeline: 876130000,
                    best_case: 876130001,
                    committed: 876130002,
                    upside: 876130006,
                };
                const buFilter = business_unit
                    ? `<filter><condition attribute="sn_name" operator="eq" value="${business_unit}"/></filter>`
                    : "";
                const buJoinType = business_unit ? "inner" : "left-outer";
                const sfFetchxml = `<fetch top="10">
  <entity name="sn_specialistforecast">
    <attribute name="sn_specialistforecastid"/>
    <attribute name="sn_specialistforecastcategory"/>
    <filter type="and">
      <condition attribute="ownerid" operator="eq" value="${userGuid}"/>
      <condition attribute="sn_opportunity" operator="eq" value="${oppId}"/>
      <condition attribute="statecode" operator="eq" value="0"/>
    </filter>
    <link-entity name="sn_productbusinessunit" from="sn_productbusinessunitid" to="sn_businessunit" link-type="${buJoinType}" alias="bu">
      <attribute name="sn_name"/>
      ${buFilter}
    </link-entity>
  </entity>
</fetch>`;
                const sfRecords = await queryRecords({ entity: "sn_specialistforecasts", fetchxml: sfFetchxml });
                if (!sfRecords.value.length) {
                    throw new Error(`No specialist forecast found for opportunity ${opportunity_number ?? oppId}${business_unit ? ` / BU ${business_unit}` : ""}`);
                }
                const updated = [];
                for (const rec of sfRecords.value) {
                    const sfId = rec.sn_specialistforecastid;
                    await updateRecord("sn_specialistforecasts", sfId, {
                        sn_specialistforecastcategory: FORECAST_CODES[forecast_category],
                    });
                    updated.push({ id: sfId, bu: rec["bu.sn_name"] ?? "Unknown" });
                }
                result = {
                    message: `Updated ${updated.length} specialist forecast record(s) to '${forecast_category}'`,
                    updated,
                };
                break;
            }
            case "get_at_risk_deals": {
                const { email, close_quarter, stale_days = 30, include_overdue = true, include_stale = true, include_misaligned = true, } = args;
                const userGuid = await resolveUserGuid(email);
                const now = new Date();
                const today = now.toISOString().split("T")[0];
                const staleThreshold = new Date(now.getTime() - stale_days * 86400000).toISOString().split("T")[0];
                const baseSelect = [
                    "name", "sn_number", "estimatedclosedate", "sn_forecastcategory",
                    "sn_netnewacv", "sn_salesstage", "sn_closequarter", "sn_probability", "modifiedon",
                ];
                const roleOrBlock = `
          <filter type="or">
            <condition attribute="ownerid" operator="eq" value="${userGuid}"/>
            <condition attribute="sn_fieldsalesrep" operator="eq" value="${userGuid}"/>
            <condition attribute="sn_solutionconsultant" operator="eq" value="${userGuid}"/>
            <condition attribute="sn_secondarysalesrep" operator="eq" value="${userGuid}"/>
          </filter>`;
                const quarterCond = close_quarter
                    ? `<condition attribute="sn_closequarter" operator="eq" value="${close_quarter}"/>`
                    : "";
                const atRisk = {};
                if (include_overdue) {
                    const r = await queryRecords({
                        entity: "opportunities",
                        fetchxml: `<fetch top="50">
  <entity name="opportunity">
    ${baseSelect.map((f) => `<attribute name="${f}"/>`).join("\n    ")}
    <filter type="and">
      <condition attribute="statecode" operator="eq" value="0"/>
      <condition attribute="estimatedclosedate" operator="lt" value="${today}"/>
      ${quarterCond}
      ${roleOrBlock}
    </filter>
    <order attribute="estimatedclosedate" descending="false"/>
  </entity>
</fetch>`,
                    });
                    atRisk.overdue = r.value;
                }
                if (include_stale) {
                    const r = await queryRecords({
                        entity: "opportunities",
                        fetchxml: `<fetch top="50">
  <entity name="opportunity">
    ${baseSelect.map((f) => `<attribute name="${f}"/>`).join("\n    ")}
    <filter type="and">
      <condition attribute="statecode" operator="eq" value="0"/>
      <condition attribute="modifiedon" operator="lt" value="${staleThreshold}"/>
      ${quarterCond}
      ${roleOrBlock}
    </filter>
    <order attribute="modifiedon" descending="false"/>
  </entity>
</fetch>`,
                    });
                    atRisk[`stale_over_${stale_days}d`] = r.value;
                }
                if (include_misaligned) {
                    const r = await queryRecords({
                        entity: "opportunities",
                        fetchxml: `<fetch top="50">
  <entity name="opportunity">
    ${baseSelect.map((f) => `<attribute name="${f}"/>`).join("\n    ")}
    <filter type="and">
      <condition attribute="statecode" operator="eq" value="0"/>
      <condition attribute="sn_probability" operator="lt" value="30"/>
      <filter type="or">
        <condition attribute="sn_forecastcategory" operator="eq" value="876130002"/>
        <condition attribute="sn_forecastcategory" operator="eq" value="876130001"/>
      </filter>
      ${quarterCond}
      ${roleOrBlock}
    </filter>
    <order attribute="sn_netnewacv" descending="true"/>
  </entity>
</fetch>`,
                    });
                    atRisk.misaligned_category = r.value;
                }
                const totalIssues = Object.values(atRisk).reduce((sum, arr) => sum + arr.length, 0);
                result = {
                    checked_on: today,
                    stale_threshold_days: stale_days,
                    total_issues: totalIssues,
                    at_risk: atRisk,
                };
                break;
            }
            case "search_opportunities": {
                const { query, status = "open", close_quarter, top = 15 } = args;
                const STATUS_CODES = { open: 0, won: 1, lost: 2 };
                const baseSelect = [
                    "opportunityid", "name", "sn_number", "sn_salesstage", "sn_forecastcategory",
                    "estimatedclosedate", "sn_netnewacv", "sn_closequarter", "statecode", "sn_probability",
                ];
                const statusFilter = status !== "all" ? ` and statecode eq ${STATUS_CODES[status] ?? 0}` : "";
                const quarterFilter = close_quarter ? ` and sn_closequarter eq '${close_quarter}'` : "";
                const byName = await queryRecords({
                    entity: "opportunities",
                    filter: `contains(name, '${query}')${statusFilter}${quarterFilter}`,
                    select: baseSelect,
                    orderby: "estimatedclosedate asc",
                    top,
                });
                const statusCond = status !== "all"
                    ? `<condition attribute="statecode" operator="eq" value="${STATUS_CODES[status] ?? 0}"/>`
                    : "";
                const quarterCond = close_quarter
                    ? `<condition attribute="sn_closequarter" operator="eq" value="${close_quarter}"/>`
                    : "";
                const byAccount = await queryRecords({
                    entity: "opportunities",
                    fetchxml: `<fetch top="${top}">
  <entity name="opportunity">
    ${baseSelect.map((f) => `<attribute name="${f}"/>`).join("\n    ")}
    <filter type="and">
      ${statusCond}
      ${quarterCond}
    </filter>
    <link-entity name="account" from="accountid" to="customerid" link-type="inner" alias="acc">
      <attribute name="name"/>
      <filter>
        <condition attribute="name" operator="like" value="%${query}%"/>
      </filter>
    </link-entity>
    <order attribute="estimatedclosedate" descending="false"/>
  </entity>
</fetch>`,
                });
                const seen = new Set();
                const merged = [];
                for (const opp of [...byName.value, ...byAccount.value]) {
                    const id = opp.opportunityid;
                    if (id && !seen.has(id)) {
                        seen.add(id);
                        merged.push(opp);
                    }
                }
                result = {
                    query,
                    total: merged.length,
                    opportunities: merged.slice(0, top),
                };
                break;
            }
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (err) {
        const msg = formatError(err);
        throw new McpError(ErrorCode.InternalError, msg);
    }
}
