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
/** Plafond de sessions simultanées (borne la mémoire du daemon). */
const MAX_SESSIONS = Number(process.env.MCP_DYNAMICS_MAX_SESSIONS ?? 100);
/** Durée d'inactivité après laquelle une session est fermée (ms, défaut 30 min). */
const SESSION_IDLE_MS = Number(process.env.MCP_DYNAMICS_SESSION_IDLE_MS ?? 30 * 60_000);
/**
 * Origines navigateur autorisées. Vide (défaut) = tout `Origin` est refusé :
 * un serveur MCP local n'est pas censé être appelé depuis une page web, et
 * l'absence de contrôle facilite le DNS-rebinding vers 127.0.0.1.
 */
const ALLOWED_ORIGINS = (process.env.MCP_DYNAMICS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
const sessions = new Map();
/** Ferme les sessions inactives ; renvoie le nombre fermé. */
function sweepIdleSessions() {
    const now = Date.now();
    let closed = 0;
    for (const [id, session] of sessions) {
        if (now - session.lastSeen > SESSION_IDLE_MS) {
            sessions.delete(id);
            closed += 1;
            void session.transport.close().catch(() => undefined);
        }
    }
    return closed;
}
// Purge périodique des sessions inactives (`unref` : ne bloque pas la sortie).
const sessionTimer = setInterval(sweepIdleSessions, Math.max(60_000, SESSION_IDLE_MS / 2));
if (typeof sessionTimer.unref === "function")
    sessionTimer.unref();
/** Marque une session comme active (appelée à chaque requête dessus). */
function touch(id) {
    const session = sessions.get(id);
    if (session)
        session.lastSeen = Date.now();
    return session;
}
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
/**
 * Refuse les requêtes portant un en-tête `Origin` non autorisé. Les clients MCP
 * (CLI, SDK) n'envoient pas d'`Origin` ; seule une page web le fait, et c'est
 * exactement le vecteur DNS-rebinding vers 127.0.0.1.
 */
function checkOrigin(req, res, next) {
    const origin = req.get("origin");
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        res.status(403).json({ error: "forbidden_origin" });
        logJson({ event: "origin_denied", origin, path: req.path });
        return;
    }
    next();
}
// ---------------------------------------------------------------------------
// Serveur
// ---------------------------------------------------------------------------
const app = express();
app.get("/healthz", (_req, res) => {
    // Réponse MINIMALE, non authentifiée : on n'expose ni l'URL d'instance, ni la
    // liste d'entités autorisées, ni le mode read-only (détails réservés au
    // endpoint authentifié ci-dessous).
    res.json({ status: "ok" });
});
/** Diagnostic détaillé : derrière l'authentification. */
app.get("/healthz/full", authenticate, (_req, res) => {
    res.json({
        status: "ok",
        tools: recordTools.length,
        sessions: sessions.size,
        readonly: HTTP_READONLY,
        environment: environment(),
    });
});
app.use("/mcp", checkOrigin, authenticate, limiter);
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
            if (sessions.size >= MAX_SESSIONS) {
                res.status(503).json({
                    error: `session_limit_reached: ${sessions.size} active sessions (max ${MAX_SESSIONS}). Close idle clients or raise MCP_DYNAMICS_MAX_SESSIONS.`,
                });
                logJson({ event: "session_limit", active: sessions.size });
                return;
            }
            const server = createMcpServer();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (id) => {
                    sessions.set(id, { transport, lastSeen: Date.now() });
                    logJson({ event: "session_opened", session_id: id, active: sessions.size });
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
        const session = touch(sessionId);
        if (!session) {
            res.status(404).json({
                error: "session_not_found: the session expired or was never opened. Re-initialize.",
            });
            logJson({ event: "session_missing", session_id: sessionId });
            return;
        }
        await session.transport.handleRequest(req, res, req.body);
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
    const session = touch(sessionId);
    if (!session) {
        res.status(404).json({ error: "session_not_found" });
        return;
    }
    try {
        await session.transport.handleRequest(req, res);
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
    const session = sessions.get(sessionId);
    if (!session) {
        res.status(404).json({ error: "session_not_found" });
        return;
    }
    await session.transport.handleRequest(req, res);
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