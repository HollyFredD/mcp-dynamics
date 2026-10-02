#!/usr/bin/env node
/**
 * Transport stdio : le mode historique, utilisé par Claude Code / Claude Desktop.
 *
 * ⚠️ Ce mode n'est PAS un daemon. Le client MCP spawn ce process, parle sur
 * stdin/stdout, et le process meurt avec le client. Pour un service qui
 * tourne en arrière-plan, voir `src/http.ts` (transport Streamable HTTP).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { environment } from "./dataverse.js";
import { logJson } from "./log.js";
import { recordTools } from "./tools/records.js";

async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr uniquement : stdout porte le protocole MCP.
  logJson({
    event: "server_started",
    transport: "stdio",
    tools: recordTools.length,
    environment: environment(),
  });
}

main().catch((err: unknown) => {
  logJson({ event: "fatal", error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});