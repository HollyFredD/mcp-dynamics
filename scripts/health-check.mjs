#!/usr/bin/env node
/**
 * Health-check du serveur MCP Dynamics.
 *
 * L'ancien mcp-ctl.sh lançait le serveur avec `nohup` en redirectant stdout vers
 * un fichier : un serveur MCP stdio a BESOIN de stdin pour répondre au handshake
 * JSON-RPC, cette méthode ne pouvait donc jamais fonctionner. Ce script parle
 * réellement le protocole : il écrit `initialize` puis `tools/list` sur stdin du
 * serveur, et lit les réponses sur stdout.
 *
 * Usage:
 *   node scripts/health-check.mjs                 # utilise dist/index.js
 *   node scripts/health-check.mjs src/index.ts    # lance via tsx (code source)
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] ?? "dist/index.js";
const absolute = path.isAbsolute(target) ? target : path.join(root, target);
const useTsx = /\.(ts|tsx)$/.test(absolute);

if (!existsSync(absolute)) {
  console.error(
    `[health-check] introuvable : ${absolute}\n` +
      `[health-check] Lancez d'abord \`npm run build\`, ou passez src/index.ts pour utiliser tsx.`
  );
  process.exit(2);
}

const bin = useTsx ? "npx" : "node";
const args = useTsx ? ["tsx", absolute] : [absolute];

const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], cwd: root });

let stdoutBuf = "";
const pending = new Map();
let stderrBuf = "";
const stderrLines = [];

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk;
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // stdout ne doit contenir QUE du JSON-RPC : c'est un signal d'alarme.
      console.error(`[health-check] stdout non-JSON (pollution du protocole) : ${line.slice(0, 200)}`);
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrBuf += chunk;
  const lines = stderrBuf.split("\n");
  stderrBuf = lines.pop() ?? "";
  for (const l of lines) if (l.trim()) stderrLines.push(l.trim());
});

function request(id, method, params, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

let failed = false;
const step = (ok, label, extra = "") => {
  if (!ok) failed = true;
  console.log(`${ok ? "OK  " : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
};

try {
  const init = await request(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-dynamics-health-check", version: "1.0.0" },
  });

  if (!init?.result) {
    step(false, "initialize", "pas de réponse (le serveur a peut-être planté au démarrage)");
  } else {
    step(true, "initialize", `${init.result.serverInfo?.name} v${init.result.serverInfo?.version}`);
    const instr = init.result.instructions?.length ?? 0;
    step(instr > 0, "instructions", `${instr} caractères`);
    step(
      init.result.capabilities?.tools?.listChanged === true,
      "capabilities.tools.listChanged"
    );
  }

  notify("notifications/initialized", {});

  const tools = await request(2, "tools/list", {});
  if (!tools?.result?.tools) {
    step(false, "tools/list", "pas de réponse");
  } else {
    const names = tools.result.tools.map((t) => t.name);
    step(names.length > 0, "tools/list", `${names.length} outils`);
    console.log(`\nOutils :\n  ${names.join("\n  ")}\n`);
  }

  // Un tool call qui ne touche pas le réseau mais prouve le dispatch complet.
  const ctx = await request(3, "tools/call", {
    name: "get_quarter_context",
    arguments: {},
  });
  step(
    !!ctx?.result?.content?.[0]?.text,
    "tools/call get_quarter_context",
    ctx?.result?.content?.[0]?.text?.match(/"quarter":\s*"[^"]+"/)?.[0] ?? ""
  );
} finally {
  child.kill();
  if (stderrLines.length) {
    console.log("--- stderr du serveur (dernières lignes) ---");
    for (const l of stderrLines.slice(-10)) console.log(`  ${l.slice(0, 240)}`);
  }
  console.log(failed ? "\nRÉSULTAT : ÉCHEC" : "\nRÉSULTAT : OK");
  process.exit(failed ? 1 : 0);
}