import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  queryRecords,
  getRecord,
  createRecord,
  updateRecord,
  deleteRecord,
  getEntityMetadata,
  listEntities,
  resolveUserGuid,
} from "../dataverse.js";

const COLLAB_NOTE_TYPES: Record<string, number> = {
  "Next Steps": 876130002,
  "Win/Loss": 876130000,
  "General": 876130001,
};

async function resolveOpportunityId(opportunityId?: string, opportunityNumber?: string): Promise<string> {
  if (opportunityId) return opportunityId;
  if (!opportunityNumber) throw new Error("Either opportunity_id or opportunity_number is required.");
  const result = await queryRecords({
    entity: "opportunities",
    filter: `sn_number eq '${opportunityNumber}'`,
    select: ["opportunityid"],
    top: 1,
  });
  const record = result.value[0];
  if (!record) throw new Error(`Opportunity not found: ${opportunityNumber}`);
  return record["opportunityid"] as string;
}

function formatError(err: unknown): string {
  if (axios_isAxiosError(err)) {
    const msg = (err as { response?: { data?: { error?: { message?: string } } }; message: string })
      .response?.data?.error?.message ?? (err as { message: string }).message;
    return msg;
  }
  return err instanceof Error ? err.message : String(err);
}

function axios_isAxiosError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "isAxiosError" in err;
}

export const recordTools = [
  {
    name: "query_records",
    description:
      "Query records from any Dynamics 365 entity. Use OData $filter syntax or FetchXML. Returns up to 50 records by default.",
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
    description:
      "Get metadata for a Dynamics 365 entity: primary key, primary name field, and basic info. Useful to understand the structure before querying.",
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
    description:
      "Get opportunities associated with a user by role (owner, field sales rep, solution consultant, etc.). Defaults to the currently authenticated Azure CLI user. Supports filtering by status, forecast category, close quarter, and role.",
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
    description:
      "Get the product lines (SKUs) of a Dynamics 365 opportunity from the opportunityproducts entity. Each row is a product line item with its name, business unit (Security, Risk, ITSM…), net new ACV, annual rate, start date, and currency. Use this to see WHAT is being sold on an opportunity. Do NOT use this to get specialist forecasts — use get_specialist_opportunities for that. Accepts either the opportunity GUID or its number (e.g. 'OPTY5331870').",
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
    description:
      "Get Collaboration Notes for a Dynamics 365 opportunity. Accepts either the opportunity GUID or its number (e.g. 'OPTY5331870'). Returns notes sorted by most recent first.",
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
    description:
      "Get the specialist forecast records (sn_specialistforecasts entity) for a given specialist (Solution Sales Executive). Each row is a specialist forecast assignment — it shows the specialist's allocated ACV (sn_productnnacv), their forecast category, and the linked opportunity. This is NOT the list of product lines on an opportunity: use get_opportunity_products for that. Use this tool to retrieve a specialist's pipeline filtered by their assigned business units (e.g. Security, Risk, Impact) and optionally by close quarter or opportunity status.",
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
    description:
      "Add a product line and its sub-product to a Dynamics 365 opportunity. Provide the parent forecast name (e.g. 'Security Forecast') and the sub-product name (e.g. 'Veza Forecast' or just 'Veza'). If a parent product line already exists on the opportunity, the sub-product is attached to it; otherwise a new parent line is created. Accepts either the opportunity GUID or its number (e.g. 'OPTY5331870').",
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
    description:
      "Add a Collaboration Note to a Dynamics 365 opportunity. Accepts either the opportunity GUID or its number (e.g. 'OPTY5331870').",
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
];

export async function handleRecordTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    let result: unknown;

    switch (name) {
      case "query_records": {
        const { entity, filter, select, expand, orderby, top, fetchxml } = args as {
          entity: string;
          filter?: string;
          select?: string[];
          expand?: string[];
          orderby?: string;
          top?: number;
          fetchxml?: string;
        };
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
        const { entity, id, select } = args as { entity: string; id: string; select?: string[] };
        result = await getRecord(entity, id, select);
        break;
      }
      case "create_record": {
        const { entity, data } = args as { entity: string; data: Record<string, unknown> };
        const newId = await createRecord(entity, data);
        result = { id: newId, message: `Record created with ID: ${newId}` };
        break;
      }
      case "update_record": {
        const { entity, id, data } = args as {
          entity: string;
          id: string;
          data: Record<string, unknown>;
        };
        await updateRecord(entity, id, data);
        result = { message: `Record ${id} updated successfully` };
        break;
      }
      case "delete_record": {
        const { entity, id } = args as { entity: string; id: string };
        await deleteRecord(entity, id);
        result = { message: `Record ${id} deleted successfully` };
        break;
      }
      case "get_entity_metadata": {
        const { entity } = args as { entity: string };
        result = await getEntityMetadata(entity);
        break;
      }
      case "list_entities": {
        result = await listEntities();
        break;
      }
      case "get_my_opportunities": {
        const { email, role, status, forecast_category, close_quarter, top } = args as {
          email?: string;
          role?: string;
          status?: string;
          forecast_category?: string;
          close_quarter?: string;
          top?: number;
        };

        const userGuid = await resolveUserGuid(email);

        const ROLE_FIELDS: Record<string, string> = {
          owner: "_ownerid_value",
          field_sales_rep: "_sn_fieldsalesrep_value",
          solution_consultant: "_sn_solutionconsultant_value",
          secondary_sales_rep: "_sn_secondarysalesrep_value",
          renewal_account_manager: "_sn_renewalaccountmanager_value",
        };

        const roleFilter = (role && role !== "any")
          ? `${ROLE_FIELDS[role]} eq '${userGuid}'`
          : Object.values(ROLE_FIELDS).map((f) => `${f} eq '${userGuid}'`).join(" or ");

        const filters: string[] = [`(${roleFilter})`];

        const STATUS_CODES: Record<string, number> = { open: 0, won: 1, lost: 2 };
        if (status && status !== "all") {
          filters.push(`statecode eq ${STATUS_CODES[status]}`);
        }

        const FORECAST_CODES: Record<string, number> = {
          pipeline:   876130000,
          best_case:  876130001,
          committed:  876130002,
          closed:     876130003,
          upside:     876130006,
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
        const { opportunity_id, opportunity_number } = args as {
          opportunity_id?: string;
          opportunity_number?: string;
        };
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
        const { opportunity_id, opportunity_number, note_type, top } = args as {
          opportunity_id?: string;
          opportunity_number?: string;
          note_type?: string;
          top?: number;
        };
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
        const { email, business_units, close_quarter, status, top } = args as {
          email?: string;
          business_units?: string[];
          close_quarter?: string;
          status?: string;
          top?: number;
        };

        const userGuid = await resolveUserGuid(email);

        const STATUS_CODES: Record<string, number> = { open: 0, won: 1, lost: 2 };
        const oppFilters: string[] = [];
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
          ? `<filter type="or">${business_units!.map((bu) => `<condition attribute="sn_name" operator="eq" value="${bu}"/>`).join("")}</filter>`
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
        const { opportunity_id, opportunity_number, product_name, sub_product_name, nnacv, currency, start_date } = args as {
          opportunity_id?: string;
          opportunity_number?: string;
          product_name: string;
          sub_product_name: string;
          nnacv: number;
          currency?: string;
          start_date?: string;
        };

        const oppId = await resolveOpportunityId(opportunity_id, opportunity_number);

        // 1. Find parent product by name
        const productSearch = await queryRecords({
          entity: "products",
          filter: `contains(name, '${product_name}') and statecode eq 0`,
          select: ["productid", "name"],
          top: 5,
        });
        if (!productSearch.value.length) throw new Error(`No active product found matching: ${product_name}`);
        const product = productSearch.value[0];
        const productId = product.productid as string;

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
          throw new Error(`No sub-product found matching '${sub_product_name}' under ${product.name as string}`);
        }
        const subProduct = subProductSearch.value[0];
        const subProductId = subProduct.sn_subproductid as string;

        // 3. Find or create parent opportunityproduct line
        const existingLine = await queryRecords({
          entity: "opportunityproducts",
          filter: `_opportunityid_value eq '${oppId}' and _productid_value eq '${productId}'`,
          select: ["opportunityproductid", "extendedamount"],
          top: 1,
        });

        const PRIMARY_UNIT_ID = "93c725cf-309d-4ce2-b301-c62da5add0ed";
        let oppProductId: string;
        let parentAmount: number;

        if (existingLine.value.length) {
          oppProductId = existingLine.value[0].opportunityproductid as string;
          parentAmount = (existingLine.value[0].extendedamount as number) ?? nnacv;
        } else {
          const lineData: Record<string, unknown> = {
            "opportunityid@odata.bind": `/opportunities(${oppId})`,
            "productid@odata.bind": `/products(${productId})`,
            "uomid@odata.bind": `/uoms(${PRIMARY_UNIT_ID})`,
            ispriceoverridden: true,
            priceperunit: nnacv,
            quantity: 1,
            sn_netnewannualcontractvalue: nnacv,
          };
          if (start_date) lineData.sn_startdateopportunityproduct = start_date;
          oppProductId = await createRecord("opportunityproducts", lineData);
          parentAmount = nnacv;
        }

        // 4. Resolve currency
        const CURRENCY_GUIDS: Record<string, string> = {
          EUR: "0898499a-8c89-e911-a83e-000d3a1781be",
          USD: "49af6d94-5c58-e911-a963-000d3a4e898a",
        };
        const currencyCode = (currency ?? "EUR").toUpperCase();
        const currencyId = CURRENCY_GUIDS[currencyCode];
        if (!currencyId) throw new Error(`Unsupported currency: ${currencyCode}. Supported: EUR, USD.`);

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
          message: `Added ${subProduct.sn_name as string} (${currencyCode} ${nnacv.toLocaleString()}) under ${product.name as string}`,
          parentProductLine: { id: oppProductId, reused: existingLine.value.length > 0 },
          subProductLine: { id: subProductLineId },
        };
        break;
      }
      case "add_collaboration_note": {
        const { opportunity_id, opportunity_number, note, note_type, subject } = args as {
          opportunity_id?: string;
          opportunity_number?: string;
          note: string;
          note_type?: string;
          subject?: string;
        };
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
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const msg = formatError(err);
    throw new McpError(ErrorCode.InternalError, msg);
  }
}
