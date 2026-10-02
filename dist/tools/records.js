/**
 * Registre des outils + dispatch.
 *
 * Conservé dans records.ts pour préserver l'API publique
 * (`recordTools`, `handleRecordTool`) utilisée par src/index.ts.
 */
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { formatDataverseError } from "../dataverse.js";
import { logToolCall, resetDataverseCalls, dataverseCallCount } from "../log.js";
import { crudTools, crudHandlers } from "./crud.js";
import { opportunityTools, opportunityHandlers } from "./opportunities.js";
import { forecastTools, forecastHandlers } from "./forecast.js";
import { metaTools, metaHandlers } from "./meta.js";
import { toolResult, isMcpError, shortError } from "./common.js";
/** Les 18 outils historiques, plus les 8 nouveaux. */
export const recordTools = [
    ...crudTools,
    ...opportunityTools,
    ...forecastTools,
    ...metaTools,
];
const handlers = {
    ...crudHandlers,
    ...opportunityHandlers,
    ...forecastHandlers,
    ...metaHandlers,
};
/** Noms des outils, utile pour la doc et les diagnostics. */
export function toolNames() {
    return recordTools.map((t) => t.name);
}
function countRows(result) {
    if (result && typeof result === "object") {
        const r = result;
        for (const key of [
            "records",
            "value",
            "opportunities",
            "notes",
            "product_lines",
            "fields",
            "groups",
            "entities",
            "values",
            "specialist_forecasts",
            "calls",
            "at_risk",
        ]) {
            const v = r[key];
            if (Array.isArray(v))
                return v.length;
        }
        if (typeof r.row_count === "number")
            return r.row_count;
        if (typeof r.line_count === "number")
            return r.line_count;
    }
    return undefined;
}
/**
 * Point d'entrée unique. Gère :
 *  - le dispatch vers le bon handler (H5 : plus de conversion McpError -> InternalError)
 *  - la journalisation stderr d'une ligne JSON par appel (T3)
 *  - le compteur d'appels Dataverse par invocation
 */
export async function handleRecordTool(name, args) {
    const started = Date.now();
    resetDataverseCalls();
    const handler = handlers[name];
    if (!handler) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool '${name}'. Available tools: ${toolNames().join(", ")}.`);
    }
    try {
        const result = await handler(args);
        logToolCall({
            ts: new Date().toISOString(),
            tool: name,
            duration_ms: Date.now() - started,
            ok: true,
            rows: countRows(result),
            dataverse_calls: dataverseCallCount(),
        });
        return toolResult(result);
    }
    catch (err) {
        // H5 : ne jamais avaler une McpError (validation comprise) en InternalError.
        const mcp = isMcpError(err) ? err : formatDataverseError(err);
        logToolCall({
            ts: new Date().toISOString(),
            tool: name,
            duration_ms: Date.now() - started,
            ok: false,
            error: shortError(mcp),
            dataverse_calls: dataverseCallCount(),
        });
        throw mcp;
    }
}
//# sourceMappingURL=records.js.map