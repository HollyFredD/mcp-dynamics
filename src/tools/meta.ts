import { recentToolCalls } from "../log.js";
import { environment } from "../dataverse.js";
import { intIn, str } from "../validate.js";
import { quarterContext, currentQuarter } from "../dates.js";
import type { ToolDef, ToolHandler } from "./crud.js";

// ===========================================================================
// get_quarter_context (F5)
// ===========================================================================
const getQuarterContextTool: ToolDef = {
  name: "get_quarter_context",
  description:
    "Normalizes a quarter string ('26-Q3', '2026-Q3', '26Q3', 'Q3-26' are all accepted) and returns its start/end dates, whether it is current/past, days remaining, and the previous/next quarter. Use it BEFORE any quarter-filtered tool to eliminate an entire family of scope errors.",
  inputSchema: {
    type: "object",
    properties: {
      quarter: {
        type: "string",
        description: "Quarter to describe. Omit for the current quarter.",
      },
    },
  },
};

async function handleGetQuarterContext(args: Record<string, unknown>): Promise<unknown> {
  const quarter = str(args.quarter, "quarter", { max: 32 });
  const ctx = quarterContext(quarter ?? currentQuarter());
  return {
    ...ctx,
    input: quarter ?? null,
    guidance:
      ctx.is_past
        ? "This quarter is in the PAST: forecast numbers are final unless amended. Consider the current quarter for live forecast work."
        : ctx.is_current
          ? `This is the CURRENT quarter: ${ctx.days_remaining} day(s) remaining (${ctx.percent_elapsed}% elapsed). Prioritise deals closing in the next 2 weeks.`
          : `This quarter starts in ${-ctx.days_elapsed} day(s). No deal should be counted in it yet unless it was already committed.`,
    quarters_in_scope: {
      current: currentQuarter(),
      previous: ctx.prev_quarter,
      next: ctx.next_quarter,
    },
  };
}

// ===========================================================================
// get_recent_tool_calls (T3)
// ===========================================================================
const getRecentToolCallsTool: ToolDef = {
  name: "get_recent_tool_calls",
  description:
    "Returns what this server has just done: one JSON entry per tool call with tool name, duration, success, error, row count and number of Dataverse HTTP calls. Use it to answer 'what did you just do to my pipeline?'. Logs are written to stderr only, never to stdout.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "How many recent calls to return (default 20, max 100)" },
      only_failures: {
        type: "boolean",
        description: "Only return failed calls (default false)",
      },
      tool: {
        type: "string",
        description: "Filter on a tool name, e.g. 'update_opportunity_forecast'",
      },
    },
  },
};

async function handleGetRecentToolCalls(args: Record<string, unknown>): Promise<unknown> {
  const limit = intIn(args.limit, "limit", { def: 20, min: 1, max: 100 });
  const onlyFailures = args.only_failures === true;
  const tool = str(args.tool, "tool", { max: 100 });

  let calls = recentToolCalls(limit);
  if (onlyFailures) calls = calls.filter((c) => !c.ok);
  if (tool) calls = calls.filter((c) => c.tool === tool);

  const writes = calls.filter((c) => /^(create_record|update_record|delete_record|update_|add_)/.test(c.tool));

  return {
    call_count: calls.length,
    filter: { only_failures: onlyFailures, tool: tool ?? null },
    environment: environment(),
    mutation_calls: writes.map((c) => ({
      ts: c.ts,
      tool: c.tool,
      ok: c.ok,
      error: c.error,
      duration_ms: c.duration_ms,
    })),
    calls,
  };
}

// ===========================================================================

export const metaTools: ToolDef[] = [getQuarterContextTool, getRecentToolCallsTool];

export const metaHandlers: Record<string, ToolHandler> = {
  get_quarter_context: handleGetQuarterContext,
  get_recent_tool_calls: handleGetRecentToolCalls,
};