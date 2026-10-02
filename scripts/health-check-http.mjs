#!/usr/bin/env node
/**
 * Health-check du serveur en mode HTTP (Streamable HTTP).
 *
 * Vérifie ce que le stdio health-check ne peut pas faire : le serveur écoute
 * vraiment sur un port, répond sur HTTP, et rejette les appels non authentifiés.
 *
 * Usage:
 *   node scripts/health-check-http.mjs [--url http://127.0.0.1:3000] [--token <t>]
 *
 * Si --url/--token sont absents, les valeurs sont lues dans l'environnement
 * (MCP_DYNAMICS_HTTP_PORT / MCP_DYNAMICS_HTTP_TOKEN), et le serveur est démarré
 * automatiquement s'il ne répond pas déjà.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(process.env.MCP_DYNAMICS_HTTP_PORT ?? 3000);
const TOKEN =
  arg("token", process.env.MCP_DYNAMICS_HTTP_TOKEN) ??
  "health-check-dev-token-do-not-use-in-production";
const BASE = arg("url", `http://127.0.0.1:${PORT}`);

let passed = 0;
let failed = 0;

function check(label, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`OK    ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`ÉCHEC ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- Démarrage du serveur si nécessaire ------------------------------------
let child = null;

async function isUp() {
  try {
    const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

if (!(await isUp())) {
  const entry = path.join(root, "dist/http.js");
  if (!existsSync(entry)) {
    console.error(`[health-check-http] introuvable : ${entry}\nLancez d'abord \`npm run build\`.`);
    process.exit(2);
  }
  console.log(`[health-check-http] démarrage de ${entry} sur ${BASE}…\n`);
  child = spawn("node", [entry], {
    stdio: ["ignore", "inherit", "pipe"],
    cwd: root,
    env: { ...process.env, MCP_DYNAMICS_HTTP_TOKEN: TOKEN },
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => process.stderr.write(c));

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isUp()) break;
    if (child.exitCode !== null) {
      console.error("[health-check-http] le serveur s'est arrêté au démarrage.");
      process.exit(1);
    }
  }
  if (!(await isUp())) {
    console.error("[health-check-http] le serveur n'a pas démarré en 10 s.");
    child.kill("SIGTERM");
    process.exit(1);
  }
}

console.log(`[health-check-http] test de ${BASE}\n`);

// --- Tests ------------------------------------------------------------------

// 1. /healthz
const health = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(5000) });
const healthBody = await health.json().catch(() => ({}));
check("GET /healthz", health.ok, `${healthBody.tools} outils, readonly=${healthBody.readonly}`);

// 2. tools/call sans token -> 401
const unauth = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "health-check", version: "1.0.0" },
    },
  }),
  signal: AbortSignal.timeout(5000),
});
check("POST /mcp sans token refusé", unauth.status === 401, `HTTP ${unauth.status}`);

// 3. handshake authentifié
let sessionId = null;
const initRes = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${TOKEN}`,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "health-check", version: "1.0.0" },
    },
  }),
  signal: AbortSignal.timeout(10_000),
});
sessionId = initRes.headers.get("mcp-session-id");
const initBody = await initRes.text();
check("initialize", initRes.ok && initBody.includes("mcp-dynamics"), `session=${sessionId ?? "aucune"}`);
check("mcp-session-id émis", Boolean(sessionId));

if (!sessionId) {
  console.log(`\n[health-check-http] pas de session, arrêt.\n${initBody.slice(0, 400)}`);
  child?.kill("SIGTERM");
  process.exit(1);
}

const commonHeaders = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  authorization: `Bearer ${TOKEN}`,
  "mcp-session-id": sessionId,
};

// 4. notifications/initialized (obligatoire avant tools/list)
await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: commonHeaders,
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  signal: AbortSignal.timeout(5000),
});

// 5. tools/list
const listRes = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: commonHeaders,
  body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
  signal: AbortSignal.timeout(10_000),
});
const listBody = await listRes.text();
const toolCount = (listBody.match(/"name":"[a-z_]+"/g) ?? []).length;
check("tools/list", listRes.ok, `${toolCount} outils`);

// 6. tools/call sur un outil qui ne touche PAS Dataverse
const callRes = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: commonHeaders,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "get_quarter_context", arguments: {} },
  }),
  signal: AbortSignal.timeout(10_000),
});
const callBody = await callRes.text();
check("tools/call get_quarter_context", callRes.ok && callBody.includes("quarter"), callRes.ok ? "" : callBody.slice(0, 200));

// 7. session inconnue -> 404
const badRes = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { ...commonHeaders, "mcp-session-id": "00000000-0000-0000-0000-000000000000" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }),
  signal: AbortSignal.timeout(5000),
});
check("session inconnue rejetée", badRes.status === 404, `HTTP ${badRes.status}`);

// 8. DELETE termine la session
const delRes = await fetch(`${BASE}/mcp`, {
  method: "DELETE",
  headers: commonHeaders,
  signal: AbortSignal.timeout(5000),
});
check("DELETE /mcp (terminaison)", delRes.status < 400 || delRes.status === 405, `HTTP ${delRes.status}`);

console.log(`\nRÉSULTAT : ${failed === 0 ? "OK" : `${failed} ÉCHEC(S)`} (${passed} vérifications passées)`);

child?.kill("SIGTERM");
process.exit(failed === 0 ? 0 : 1);