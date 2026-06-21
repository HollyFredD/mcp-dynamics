import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { queryRecords, getRecord, createRecord, updateRecord, deleteRecord, getEntityMetadata, listEntities, } from "../dataverse.js";
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
