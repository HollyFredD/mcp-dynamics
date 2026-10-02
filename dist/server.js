/**
 * Construction du serveur MCP — indépendant du transport.
 *
 * Ce module est volontairement séparé de `index.ts` (stdio) et `http.ts`
 * (Streamable HTTP) : les deux doivent exposer exactement les mêmes outils et
 * les mêmes instructions. Toute divergence entre les deux modes serait un bug
 * très difficile à voir (un mode « marche », l'autre non).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { recordTools, handleRecordTool } from "./tools/records.js";
export const INSTRUCTIONS = `

# Dynamics 365 / Dataverse — ServiceNow sales pipeline

## Identifiants
- **sn_number** (format 'OPTY1234567') is the business identifier of an opportunity. ALWAYS return it in your answers — a GUID alone is useless to a human. Use it as the join key when talking about deals.
- 'opportunityid' / 'sn_specialistforecastid' are technical GUIDs: use them for follow-up calls, never as a user-facing label.

## Money
- 'sn_netnewacv' is expressed in the **local currency** of the opportunity. Never sum it across opportunities with different 'sn_currencycode' values.
- Use 'sn_netnewacv_base' (and the other '*_base' fields) when you need to compare amounts **across** environments/currencies: those are converted to the organisation's base currency.
- 'sn_renewalacv' / 'sn_totalvalue' sit alongside 'sn_netnewacv'; they are NOT additive — 'sn_totalvalue' already includes them.

## Probability — critical gotcha
- 'sn_probability' is a **CALCULATED string** (e.g. '"100%'). It can only ever be *displayed*. **Never write it**, and never filter on it.
- The numeric probability is 'closeprobability' (integer 0-100). Use that for anything computable (thresholds, comparisons, sorting).

## Forecast: TWO levels, read both
- **Opportunity level**: 'sn_forecastcategory' on 'opportunities'.
- **Specialist level**: 'sn_specialistforecastcategory' on 'sn_specialistforecasts' (one row per specialist x business unit), plus its reporting twin 'sn_specialistforecastcategoryreporting'.
- They can disagree. A forecast number quoted to a manager is only trustworthy if both levels agree — check with 'get_forecast_integrity'.
- Valid forecast_category values are 'pipeline | best_case | committed | upside | closed'. **'closed' is not writable, and 'won' is not a forecast category** — won/lost live in 'statecode' (0 open, 1 won, 2 lost).

## The specialist forecast is NOT a product line
- 'sn_specialistforecast' = forecast rows (specialist x BU). Use 'get_specialist_opportunities'.
- 'opportunityproducts' = the SKUs actually being sold. Use 'get_opportunity_products'.
- 'sn_opportunitysubproductses' = the ACV allocation of each sub-product inside a product line.

## Quarters
- Always format quarters as 'YY-Qn', e.g. **26-Q3**. Values like '2026-Q3', '26Q3' and 'Q3-26' are accepted and normalized automatically, but always answer in 'YY-Qn'.
- 'sn_closequarter' is a plain string on the opportunity. If you change 'estimatedclosedate' without changing 'sn_closequarter', the deal is still counted in the old quarter — 'update_opportunity_forecast' recomputes the quarter for you.
- Use 'get_quarter_context' to know where you stand (start/end date, days remaining).

## Choosing a tool
- Prefer the business tools over raw 'query_records': 'get_my_opportunities', 'get_forecast_summary', 'get_at_risk_deals', 'get_team_forecast', 'get_closing_readiness'.
- **Before writing any field name you are not 100% sure of**, call 'describe_entity_fields(entity, search='...')'. Do not invent field names.
- To decode a numeric code (win/loss reason, risk type, sales stage, forecast category), call 'list_picklist_values(entity, attribute)'.
- Use 'aggregate_query' rather than downloading rows and summing them yourself — aggregation runs server-side and is not capped.

## Writes
- Every mutating tool is a **dry run by default**: it returns the exact diff it would apply. Pass 'dry_run: false' to actually write.
- 'delete_record' requires 'confirm: true' and is permanently forbidden on system entities (users, roles, permissions, settings, business units, teams).
- Writing to entities outside the allow-list is refused.
- After writing, the server re-reads the record and reports the actual stored values, because Dataverse silently ignores read-only and calculated fields.

## Reading volume
- Any result can be truncated. Results always report 'truncated', 'has_more' and 'total_count'. Never present a truncated result as a complete total.
- Use 'get_recent_tool_calls' to audit what this server just did.
`;
/** Crée une instance de serveur MCP neuve, avec ses handlers branchés. */
export function createMcpServer() {
    const server = new Server({ name: "mcp-dynamics", version: "1.0.0" }, {
        instructions: INSTRUCTIONS,
        capabilities: { tools: { listChanged: true } },
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: recordTools,
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name, arguments: args } = req.params;
        return handleRecordTool(name, (args ?? {}));
    });
    return server;
}
//# sourceMappingURL=server.js.map