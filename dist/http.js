#!/usr/bin/env node
/**
 * Transport Streamable HTTP — le mode « daemon ».
 *
 * stdio ne peut pas tourner en arrière-plan (le process est le client MCP, il
 * naît et meurt avec lui). Ce fichier expose le même serveur sur `POST /mcp`.
 *
 * ## Modèle de sécurité — mono-identité
 *
 * Le serveur s'authentifie avec `AzureCliCredential`, c'est-à-dire **le token
 * du compte qui a lancé `az login` sur cette machine**. Il n'y a pas d'identité
 * par appelant : quiconque atteint le port agit AU NOM DE CE COMPTE.
 *
 * Conséquences non négociables :
 *   1. `MCP_DYNAMICS_HTTP_TOKEN` est OBLIGATOIRE. Sans lui le serveur refuse de
 *      démarrer — on n'expose pas un CRM sur le réseau sans authentification.
 *   2. Le read-only est activé PAR DÉFAUT sur ce transport
 *      (`MCP_DYNAMICS_READONLY=0` pour l'écarter explicitement).
 *   3. Écouter sur 0.0.0.0 est refusé par défaut : bind sur 127.0.0.1. Pour une
 *      exposition au réseau, passer par un reverse proxy (TLS + auth), sinon le
 *      token Bearer voyage en clair.
 *
 * Pour un vrai multi-utilisateurs : il faudrait un credential par appelant et
 * supprimer le `WhoAmI` implicite de `resolveUserGuid`. Non implémenté ici.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
// `dataverse.ts` lit MCP_DYNAMICS_TRANSPORT pour décider du read-only par
// défaut. En ESM les imports sont hissés : on doit donc passer par des imports
// dynamiques pour garantir que la variable est posée avant l'évaluation.
process.env.MCP_DYNAMICS_TRANSPORT = "http";
const { createMcpServer } = await import("./server.js");
const { environment, READONLY } = await import("./dataverse.js");
const { logJson, redact } = await import("./log.js");
const { recordTools } = await import("./tools/records.js");
// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.MCP_DYNAMICS_HTTP_PORT ?? 3000);
const HOST = process.env.MCP_DYNAMICS_HTTP_HOST ?? "127.0.0.1";
const HTTP_TOKEN = process.env.MCP_DYNAMICS_HTTP_TOKEN ?? "";
if (!HTTP_TOKEN) {
    logJson({
        event: "fatal",
        error: "MCP_DYNAMICS_HTTP_TOKEN is required in HTTP mode. Generate one with: openssl rand -hex 32",
    });
    process.exit(1);
}
/**
 * Le mode read-only est décidé dans `dataverse.ts` (READONLY), qui lit
 * MCP_DYNAMICS_TRANSPORT — variable posée plus haut dans ce fichier. On ne le
 * redéfinit PAS ici : une valeur d'affichage qui diverge de la garde effective
 * donnerait un faux sentiment de sécurité.
 */
const HTTP_READONLY = READONLY;
if (!HTTP_READONLY) {
    logJson({
        event: "warn",
        message: "WRITES ENABLED over HTTP. Anyone who can reach this port acts as the Azure CLI identity. Put it behind TLS.",
    });
}
/** Sessions MCP en cours, indexées par sessionId. */
const sessions = new Map();
// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
/** Comparaison à temps constant : évite de fuir le token par timing. */
function tokenMatches(provided) {
    if (provided.length !== HTTP_TOKEN.length)
        return false;
    let diff = 0;
    for (let i = 0; i < provided.length; i++) {
        diff |= provided.charCodeAt(i) ^ HTTP_TOKEN.charCodeAt(i);
    }
    return diff === 0;
}
function authenticate(req, res, next) {
    const header = req.get("authorization") ?? "";
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const headerToken = req.get("x-mcp-token") ?? "";
    if (!tokenMatches(bearer || headerToken)) {
        res
            .status(401)
            .set("WWW-Authenticate", 'Bearer realm="mcp-dynamics"')
            .json({ error: "unauthorized" });
        logJson({ event: "auth_denied", ip: req.ip, path: req.path });
        return;
    }
    next();
}
/** Rate limit : garde-fou contre un client LLM en boucle d'erreurs. */
const limiter = rateLimit({
    windowMs: 60_000,
    limit: Number(process.env.MCP_DYNAMICS_HTTP_RATE ?? 120),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "rate_limited" },
});
// ---------------------------------------------------------------------------
// Serveur
// ---------------------------------------------------------------------------
const app = express();
app.get("/healthz", (_req, res) => {
    res.json({
        status: "ok",
        tools: recordTools.length,
        sessions: sessions.size,
        readonly: HTTP_READONLY,
        environment: environment(),
    });
});
app.use("/mcp", authenticate, limiter);
app.use(express.json({ limit: "4mb" }));
/**
 * Une instance de `Server` par session : le SDK ne permet pas de reconnecter un
 * même serveur à deux transports. Une session = un client MCP.
 */
app.post("/mcp", async (req, res) => {
    try {
        const sessionId = req.get("mcp-session-id");
        // Requête d'initialisation : ouvre une session.
        if (!sessionId && isInitializeRequest(req.body)) {
            const server = createMcpServer();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (id) => {
                    sessions.set(id, transport);
                    logJson({ event: "session_opened", session_id: id });
                },
            });
            transport.onclose = () => {
                if (transport.sessionId)
                    sessions.delete(transport.sessionId);
            };
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            return;
        }
        // Les autres requêtes exigent une session connue.
        if (!sessionId) {
            res.status(400).json({
                error: "bad_request: missing mcp-session-id — send an initialize request first",
            });
            return;
        }
        const transport = sessions.get(sessionId);
        if (!transport) {
            res.status(404).json({
                error: "session_not_found: the session expired or was never opened. Re-initialize.",
            });
            logJson({ event: "session_missing", session_id: sessionId });
            return;
        }
        await transport.handleRequest(req, res, req.body);
    }
    catch (err) {
        logJson({
            event: "request_error",
            error: redact(err instanceof Error ? err.message : String(err)),
        });
        if (!res.headersSent) {
            res.status(500).json({ error: "internal_error" });
        }
    }
});
/** Flux SSE : le serveur peut Initié des notifications (ex. listChanged). */
app.get("/mcp", async (req, res) => {
    const sessionId = req.get("mcp-session-id");
    if (!sessionId) {
        res.status(400).json({ error: "bad_request: missing mcp-session-id" });
        return;
    }
    const transport = sessions.get(sessionId);
    if (!transport) {
        res.status(404).json({ error: "session_not_found" });
        return;
    }
    try {
        await transport.handleRequest(req, res);
    }
    catch (err) {
        logJson({
            event: "sse_error",
            error: redact(err instanceof Error ? err.message : String(err)),
        });
        if (!res.headersSent)
            res.status(500).json({ error: "internal_error" });
    }
});
/** Terminaison explicite de session. */
app.delete("/mcp", async (req, res) => {
    const sessionId = req.get("mcp-session-id");
    if (!sessionId) {
        res.status(400).json({ error: "bad_request: missing mcp-session-id" });
        return;
    }
    const transport = sessions.get(sessionId);
    if (!transport) {
        res.status(404).json({ error: "session_not_found" });
        return;
    }
    await transport.handleRequest(req, res);
    sessions.delete(sessionId);
});
// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------
const server = app.listen(PORT, HOST, () => {
    logJson({
        event: "server_started",
        transport: "streamable-http",
        url: `http://${HOST}:${PORT}/mcp`,
        tools: recordTools.length,
        readonly: HTTP_READONLY,
        warn: HTTP_READONLY ? null : "WRITES ENABLED over HTTP",
        environment: environment(),
    });
});
server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
        logJson({ event: "fatal", error: `port ${PORT} already in use` });
        process.exit(1);
    }
    logJson({ event: "fatal", error: err.message });
    process.exit(1);
});
function shutdown(signal) {
    logJson({ event: "shutdown", signal, sessions: sessions.size });
    server.close(() => process.exit(0));
    // Filet : si des sessions SSE restent ouvertes, on ne bloque pas.
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
//# sourceMappingURL=http.js.map