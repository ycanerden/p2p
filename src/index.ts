import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import {
  db,
  createRoom,
  joinRoom,
  appendMessage,
  getMessages,
  getRoomStatus,
  getAllMessages,
  sweepExpiredRooms,
  getRoomCount,
  checkRateLimitPersistent,
  publishCard,
  getPartnerCards,
  messageEvents,
  trackMetric,
  getMessagesPerMinute,
  getAvgLatencyMs,
  getTotalMessagesSent,
  getActiveAgentsCount,
  cleanOldMetrics,
  updatePresence,
  setTyping,
  getRoomPresence,
  addReaction,
  removeReaction,
  getMessageReactions,
  registerWebhook,
  removeWebhook,
  registerAgent,
  searchAgents,
  getAvailableAgents,
  getAllAgents,
  getAgentProfile,
  getAllAgentProfiles,
  updateAgentStatus,
  incrementAgentTasks,
  pinMessage,
  unpinMessage,
  getPinnedMessages,
  shareFile,
  getFile,
  getRoomFiles,
  createHandoff,
  acceptHandoff,
  getHandoff,
  getAgentHandoffs,
  getTemplates,
  getTemplate,
  createRoomFromTemplate,
  createDemoRoom,
  trackAgentActivity,
  getLeaderboard,
  getAgentStats,
  getProductivityReport,
  searchMessages,
  scheduleMessage,
  processScheduledMessages,
  getScheduledMessages,
  cancelScheduledMessage,
  setDisplayName,
  getDisplayName,
  verifyAdmin,
  setRoomReadOnly,
  isRoomReadOnly,
  canAgentSend,
  generateAgentToken,
  getRoomContext,
  setRoomContext,
  addToWhitelist,
  removeFromWhitelist,
  getWhitelist,
  kickAgent,
  unbanAgent,
  getBanned,
  claimRoomAdmin,
  resetAdminToken,
  ensureRoom,
  savePersonality,
  getPersonality,
  getAllPersonalities,
  generateIdentityBlock,
  isExemptFromRateLimit,
  setRateLimitExempt,
  getRateLimitExemptList,
  getActiveRooms,
  setRoomPrivate,
  isRoomPrivate,
  deleteMessage,
  redactMessage,
  rotateAdminToken,
  addToWaitlist,
  getWaitlist,
  getWaitlistCount,
  setRoomPassword,
  verifyRoomPassword,
  getRoomPasswordHash,
  getGrowthMetrics,
  getPublicRoomActivity,
  upsertGoogleAccount,
  createGoogleSession,
  getAccountBySession,
  deleteGoogleSession,
  cleanExpiredSessions,
  createProjectRoom,
  getProjectRoom,
  addDeliverable,
  updateDeliverable,
  deleteDeliverable,
  getDeliverables,
  roomExists,
} from "./rooms.js";
import { registerAdminRoutes, verifyCreator, CREATORS } from "./routes/admin.js";
import { registerTelegramRoutes } from "./routes/telegram.js";
import { registerPresenceRoutes } from "./routes/presence.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerRoomsRoutes } from "./routes/rooms.js";
import { registerMessagesRoutes } from "./routes/messages.js";
import { registerDirectoryRoutes } from "./routes/directory.js";
import { registerPinRoutes } from "./routes/pins.js";
import { registerHandoffRoutes } from "./routes/handoffs.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerPromptRoutes } from "./routes/prompt.js";
import {
  VERSION,
  startTime,
  SSE_ENABLED,
  activeConnections,
  checkRateLimit,
  injectAnalytics,
  hasRoomAccess,
  isValidPasswordSession,
} from "./routes/utils.js";
import {
  createRoomGroup,
  getRoomGroup,
  getAllRoomGroups,
  assignTask,
  updateTaskStatus,
  getAgentTasks,
  getRoomTasks,
  getAllAgentTasks,
} from "./room-manager.js";
import {
  appendDecision,
  appendShip,
  upsertAgentContext,
  appendDailyLog,
  getAgentContext,
  obsidianEnabled,
} from "./obsidian-memory.js";

const app = new Hono();
const GOOGLE_BACKEND = (process.env.GOOGLE_BACKEND || "gog").toLowerCase();
const GOG_BIN = process.env.GOG_BIN || "gog";
const GOG_ACCOUNT = process.env.GOG_ACCOUNT;
const GOG_CLIENT = process.env.GOG_CLIENT;

// ── Global rate limit: 1000 requests/min per IP ──────────────────────────────
// Prevents abuse from spamming the API and burning Railway budget
const ipHits = new Map<string, { count: number; reset: number }>();
app.use("*", async (c, next) => {
  const ip = c.req.header("x-forwarded-for") ?? "unknown";
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || now > entry.reset) {
    ipHits.set(ip, { count: 1, reset: now + 60_000 });
  } else {
    entry.count++;
    if (entry.count > 1000) {
      return c.json({ error: "rate_limit_exceeded", detail: "Max 1000 requests/min" }, 429);
    }
  }
  // Cleanup old entries every 5 min
  if (Math.random() < 0.001) {
    for (const [k, v] of ipHits) { if (now > v.reset) ipHits.delete(k); }
  }
  await next();
});

// ── Admin page protection (per-room) ─────────────────────────────────────────
// Each room has its own admin token + optional room password.
// Password-protected rooms require the password to access admin pages.
// Rooms without a password are open (demo/public rooms).
const ADMIN_PAGES = ["/dashboard", "/analytics", "/settings", "/compact"];

function getAdminLoginPage(redirectTo: string, room: string) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mesh — Room Login</title>
<style>body{font-family:'Inter',system-ui,sans-serif;background:#1a1a1e;color:#e8e8ed;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.box{background:#242428;border:1px solid #333338;border-radius:12px;padding:32px;width:100%;max-width:360px;text-align:center;}
h1{font-size:18px;margin-bottom:4px;}
p{font-size:12px;color:#9898a0;margin-bottom:20px;}
input{width:100%;padding:10px;background:#1a1a1e;border:1px solid #333338;border-radius:8px;color:#e8e8ed;font-size:14px;outline:none;margin-bottom:12px;box-sizing:border-box;}
input:focus{border-color:#4d94ff;}
button{width:100%;padding:10px;background:#4d94ff;border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;}
button:hover{opacity:.88;}
.err{color:#f87171;font-size:12px;margin-bottom:8px;display:none;}
a{color:#4d94ff;font-size:12px;text-decoration:none;}</style></head>
<body><div class="box"><h1>Room Login</h1><p>Enter the password for <strong>${room}</strong>.</p>
<div class="err" id="err">Wrong password</div>
<form onsubmit="return doLogin()"><input type="password" id="pw" placeholder="Room password" autofocus>
<button type="submit">Enter</button></form>
<p style="margin-top:16px"><a href="/">Back to home</a> · <a href="/office?room=${room}">View office (public)</a></p></div>
<script>function doLogin(){var t=document.getElementById('pw').value;
fetch('/admin-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:'${room}',token:t})})
.then(r=>{if(r.ok){location.href='${redirectTo}'}else{document.getElementById('err').style.display='block'}});return false;}</script></body></html>`;
}

app.post("/admin-login", async (c) => {
  const { room, token } = await c.req.json().catch(() => ({ room: "", token: "" }));
  if (!room || !token) return c.json({ error: "missing room or token" }, 400);
  // Accept either the admin token OR the room password
  const adminOk = verifyAdmin(room, token);
  const passwordOk = verifyRoomPassword(room, token);
  if (!adminOk && !passwordOk) return c.json({ error: "wrong password" }, 401);
  // Cookie value: admin token if admin auth, or "pwdsess_<hash>" for password auth
  // Using the hash means we can verify after server restarts (no in-memory state)
  const cookieValue = adminOk ? token : `pwdsess_${getRoomPasswordHash(room)}`;
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `mesh_admin_${room}=${encodeURIComponent(cookieValue)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure`,
    },
  });
});

// Middleware: protect admin pages — per room
// Password-protected rooms require login. Open rooms allow access.
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (!ADMIN_PAGES.some(p => path === p)) { await next(); return; }
  const url = new URL(c.req.url);
  const room = url.searchParams.get("room") || "mesh01";
  // Check cookie
  const cookie = c.req.header("cookie") || "";
  const match = cookie.match(new RegExp(`mesh_admin_${room}=([^;]+)`));
  if (match) {
    const val = decodeURIComponent(match[1] || "");
    if (verifyAdmin(room, val) || isValidPasswordSession(room, val)) { await next(); return; }
  }
  // Check query param token
  const tokenParam = url.searchParams.get("token");
  if (tokenParam && verifyAdmin(room, tokenParam)) { await next(); return; }
  // If room has no password, allow open access (demo/public rooms)
  if (!getRoomPasswordHash(room)) { await next(); return; }
  // Otherwise show login page
  return new Response(getAdminLoginPage(path + "?" + url.searchParams.toString(), room), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});

// ── Phase 3: Compression ──────────────────────────────────────────────────────
// Enable Gzip/Brotli compression for all responses
app.use("*", compress());

// ── CORS Configuration ────────────────────────────────────────────────────────
// Allow dashboard and frontend to make requests
// Set ALLOWED_ORIGINS env var to restrict (comma-separated), e.g. "https://trymesh.chat,https://p2p-production-983f.up.railway.app"
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim())
  : ["https://trymesh.chat"];
app.use("*", cors({
  origin: ALLOWED_ORIGINS,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "x-mesh-secret", "x-admin-token"],
  exposeHeaders: ["Content-Type"],
}));

// ── Phase 1 SSE Note ──────────────────────────────────────────────────────────
// SSE streaming is handled by /api/stream endpoint below.
// Uses Hono's streamSSE + EventEmitter pattern for clean real-time message delivery.
// No separate subscriber registry needed — EventEmitter handles subscriptions directly.

// ── Secret token auth ─────────────────────────────────────────────────────────
// ── Feature flags ─────────────────────────────────────────────────────────────
if (SSE_ENABLED) console.log("[init] SSE streaming enabled (default)");

const SECRET = process.env.MESH_SECRET;
if (SECRET) {
  app.use("*", async (c, next) => {
    // Always allow health check
    if (c.req.path === "/health") return next();
    const token = c.req.query("secret") || c.req.header("x-mesh-secret");
    if (token !== SECRET) return c.json({ error: "unauthorized" }, 401);
    return next();
  });
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Persistent SQLite-backed rate limiter (survives restarts)

function buildGogArgs(args: string[], json: boolean = false): string[] {
  const base: string[] = [];
  if (GOG_ACCOUNT) base.push(`--account=${GOG_ACCOUNT}`);
  if (GOG_CLIENT) base.push(`--client=${GOG_CLIENT}`);
  if (json) base.push("--json");
  base.push("--no-input");
  return [...base, ...args];
}

function runGog(args: string[], json: boolean = false): { ok: boolean; stdout: string; stderr: string } {
  const allowed = new Set([
    "docs create",
    "slides create",
    "sheets create",
    "sheets update",
    "drive upload",
  ]);
  const key = `${args[0] || ""} ${args[1] || ""}`.trim();
  if (!allowed.has(key)) {
    return { ok: false, stdout: "", stderr: `gogcli_command_not_allowed:${key || "unknown"}` };
  }
  const cmd = [GOG_BIN, ...buildGogArgs(args, json)];
  try {
    const result = Bun.spawnSync({
      cmd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    if (result.exitCode !== 0) {
      return { ok: false, stdout, stderr };
    }
    return { ok: true, stdout, stderr };
  } catch (e: any) {
    return { ok: false, stdout: "", stderr: e?.message || "gogcli_failed" };
  }
}

function parseJsonOutput(stdout: string): any | null {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function extractId(payload: any, keys: string[]): string | null {
  if (!payload || typeof payload !== "object") return null;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function buildDocUrl(kind: "doc" | "slides" | "sheets", id: string): string {
  if (kind === "slides") return `https://docs.google.com/presentation/d/${id}/edit`;
  if (kind === "sheets") return `https://docs.google.com/spreadsheets/d/${id}/edit`;
  return `https://docs.google.com/document/d/${id}/edit`;
}

// ── GC sweep every hour ───────────────────────────────────────────────────────
setInterval(() => {
  const swept = sweepExpiredRooms();
  cleanOldMetrics();
  if (swept > 0) console.log(`[gc] swept ${swept} expired rooms and stale rate limits`);
}, 60 * 60 * 1000);

// Process scheduled messages every 10 seconds
setInterval(() => {
  const sent = processScheduledMessages();
  if (sent > 0) console.log(`[scheduler] delivered ${sent} scheduled messages`);
}, 10_000);

// ── Simple REST API (for stdio MCP wrapper) ───────────────────────────────────

app.get("/api/status", (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  joinRoom(room, name);
  const result = getRoomStatus(room, name);
  return c.json(result);
});

// GET /api/context — retrieve the shared room context
app.get("/api/context", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  const context = getRoomContext(room);
  if (!context) return c.json({ ok: true, context: "" });
  return c.json({ ok: true, ...context });
});

// POST /api/context — update the shared room context
app.post("/api/context", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  const { content } = await c.req.json();
  if (content === undefined) return c.json({ error: "missing content" }, 400);
  setRoomContext(room, content, name);
  return c.json({ ok: true, message: "Context updated." });
});

app.get("/api/history", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  // Allow access if caller identifies as an agent (name param) — matches /api/messages behavior.
  // Password gate only blocks anonymous viewers (no name, no cookie, no token).
  const callerName = c.req.query("name") || c.req.query("viewer");
  if (!callerName && !hasRoomAccess(c, room)) {
    return c.json({ error: "room_protected", detail: "This room requires a password" }, 403);
  }
  const limit = Math.min(parseInt(c.req.query("limit") || "100"), 500);
  const since = c.req.query("since") ? parseInt(c.req.query("since")!) : undefined;
  // viewer=name includes DMs addressed to that user alongside public messages
  const viewer = c.req.query("viewer") || c.req.query("name") || undefined;
  const result = getAllMessages(room, limit, since, viewer);
  return c.json(result);
});

app.get("/api/metrics", (c) => {
  const reqStart = Date.now();
  const metrics = {
    active_rooms: getRoomCount(),
    active_connections: activeConnections.count,
    active_agents: getActiveAgentsCount(),
    messages_per_minute: getMessagesPerMinute(),
    total_messages_sent: getTotalMessagesSent(),
    avg_latency_ms: getAvgLatencyMs(),
    error_rate: 0,
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    version: VERSION,
    compression: true,
  };
  trackMetric("api_request", "system", "metrics", Date.now() - reqStart);
  return c.json(metrics);
});

// Growth metrics — 7-day daily breakdown for YC dashboard
app.get("/api/metrics/growth", (c) => {
  return c.json({ ok: true, ...getGrowthMetrics() });
});

app.get("/api/version", (c) => {
  return c.json({
    version: VERSION,
    build_date: new Date(startTime).toISOString(),
    sse_enabled: SSE_ENABLED,
    compression: "gzip/brotli",
  });
});

// ── Telegram routes (extracted to routes/telegram.ts) ───────────────────────
registerTelegramRoutes(app);

// ── Admin endpoints (extracted to routes/admin.ts) ─────────────────────────
registerAdminRoutes(app);

app.post("/api/publish", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  joinRoom(room, name);
  const { card } = await c.req.json();
  const result = publishCard(room, name, card);
  return c.json(result);
});

app.get("/api/cards", (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  joinRoom(room, name);
  const result = getPartnerCards(room, name);
  return c.json(result);
});

// ── Presence & Typing ──────────────────────────────────────────────────────
// CREATORS and verifyCreator imported from ./routes/admin.js above

// ── Interaction routes (heartbeat, typing, presence, rename, reactions) ───
registerPresenceRoutes(app);

// ── Search ─────────────────────────────────────────────────────────────────
app.get("/api/search", (c) => {
  const room = c.req.query("room");
  const q = c.req.query("q");
  if (!room || !q) return c.json({ error: "missing room or q" }, 400);
  const limit = parseInt(c.req.query("limit") || "50");
  const results = searchMessages(room, q, limit);
  return c.json({ ok: true, results, count: results.length, query: q });
});

// ── Scheduled Messages ─────────────────────────────────────────────────────
app.post("/api/schedule", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  const { message, send_at, to, type } = await c.req.json();
  if (!message || !send_at) return c.json({ error: "missing message or send_at (unix ms)" }, 400);
  const id = scheduleMessage(room, name, message, send_at, to, type || "BROADCAST");
  return c.json({ ok: true, schedule_id: id, sends_at: new Date(send_at).toISOString() }, 201);
});

app.get("/api/schedule", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  return c.json({ ok: true, scheduled: getScheduledMessages(room) });
});

app.delete("/api/schedule/:scheduleId", (c) => {
  const cancelled = cancelScheduledMessage(c.req.param("scheduleId"));
  return c.json({ ok: cancelled });
});

// ── Room Templates ─────────────────────────────────────────────────────────
app.get("/api/templates", (c) => {
  return c.json({ ok: true, templates: getTemplates() });
});

app.get("/api/templates/:templateId", (c) => {
  const t = getTemplate(c.req.param("templateId"));
  if (!t) return c.json({ error: "template not found" }, 404);
  return c.json({ ok: true, template: t });
});

app.post("/api/templates/:templateId/create-room", async (c) => {
  const name = c.req.query("name") || "anonymous";
  const result = createRoomFromTemplate(c.req.param("templateId"), name);
  return c.json(result, result.ok ? 201 : 400);
});

// ── Demo Room (One-Click) ──────────────────────────────────────────────────
app.get("/api/demo", (c) => {
  const result = createDemoRoom();
  return c.json(result, result.ok ? 200 : 400);
});

// ── Leaderboard & Stats ────────────────────────────────────────────────────
app.get("/api/leaderboard", (c) => {
  const limit = parseInt(c.req.query("limit") || "20");
  return c.json({ ok: true, leaderboard: getLeaderboard(limit) });
});

// Agent activity timeline — single room or cross-room (no room = all public rooms)
app.get("/api/activity", (c) => {
  const room = c.req.query("room");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);

  if (room) {
    const callerName = c.req.query("name") || c.req.query("viewer");
    if (!callerName && !hasRoomAccess(c, room)) {
      return c.json({ error: "room_protected", detail: "This room requires a password to view activity" }, 403);
    }

    const messagesResult = getAllMessages(room, limit);
    const presence = getRoomPresence(room);
    if (!messagesResult.ok) return c.json({ error: messagesResult.error }, 404);
    const events = (messagesResult.messages || []).map((msg) => ({
      id: msg.id,
      from: msg.from,
      room_code: room,
      type: msg.type || "BROADCAST",
      content: msg.content.slice(0, 200),
      ts: msg.ts,
    }));
    return c.json({ ok: true, room, events, agents_online: presence.filter((a) => a.status === "online").length });
  }

  // Cross-room: aggregate recent events from all PUBLIC rooms
  // Requires creator auth — don't leak all messages publicly
  if (!verifyCreator(c)) {
    return c.json({ error: "unauthorized — cross-room activity requires creator access. Provide ?room= for single room." }, 403);
  }
  const messages = getPublicRoomActivity(limit);
  return c.json({ ok: true, events: messages });
});

app.get("/api/stats/:agentName", (c) => {
  const stats = getAgentStats(c.req.param("agentName"));
  if (!stats) return c.json({ error: "agent not found" }, 404);
  return c.json({ ok: true, stats });
});

// Productivity report with breakdowns
app.get("/api/productivity/:agentName", (c) => {
  const report = getProductivityReport(c.req.param("agentName"));
  if (!report) return c.json({ error: "agent not found" }, 404);
  return c.json({ ok: true, report });
});

// Log productivity events (agents self-report work)
app.post("/api/productivity/log", async (c) => {
  const name = c.req.query("name");
  if (!name) return c.json({ error: "missing name" }, 400);
  const { activity, value } = await c.req.json();
  const validActivities = ["task_complete","commit","bug_fix","review","lines_of_code","file_share","handoff"];
  if (!validActivities.includes(activity)) return c.json({ error: "invalid activity type", valid: validActivities }, 400);
  trackAgentActivity(name, activity, value || 1);
  return c.json({ ok: true, logged: activity, value: value || 1 });
});

// ── Landing Page ─────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/index.html").text());
    return c.html(html);
  } catch (e) {
    return c.redirect("/docs");
  }
});

// V2 landing page — CLI-first, Zed/Ghostty style (preview at /v2)
app.get("/v2", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/v2.html").text());
    return c.html(html);
  } catch (e) {
    return c.redirect("/");
  }
});

// Setup wizard — guided onboarding for any AI tool
app.get("/setup", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/setup.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch {
    return c.redirect("/");
  }
});

// Invite link — /invite?room=ROOM pre-fills setup page with the room
app.get("/invite", (c) => {
  const room = c.req.query("room") || "";
  const safe = room.replace(/[^a-z0-9\-_]/gi, "").slice(0, 32);
  if (!safe) return c.redirect("/setup");
  return c.redirect(`/setup?room=${encodeURIComponent(safe)}`);
});

// ── Favicon ───────────────────────────────────────────────────────────────────
app.get("/favicon.svg", async (c) => {
  try {
    const svg = await Bun.file("./public/favicon.svg").text();
    return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
  } catch {
    return c.text("Not found", 404);
  }
});

app.get("/og-image.svg", async (c) => {
  try {
    const svg = await Bun.file("./public/og-image.svg").text();
    return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" } });
  } catch {
    return c.text("Not found", 404);
  }
});

app.get("/og-image.png", async (c) => {
  try {
    const png = await Bun.file("./public/og-image.png");
    return new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" } });
  } catch {
    return c.text("Not found", 404);
  }
});

app.get("/sitemap.xml", async (c) => {
  try {
    const xml = await Bun.file("./public/sitemap.xml").text();
    return new Response(xml, { headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=86400" } });
  } catch {
    return c.text("Not found", 404);
  }
});

app.get("/robots.txt", async (c) => {
  try {
    const txt = await Bun.file("./public/robots.txt").text();
    return new Response(txt, { headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" } });
  } catch {
    return c.text("Not found", 404);
  }
});

app.get("/changelog", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/changelog.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch {
    return c.redirect("/");
  }
});

app.get("/privacy", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/privacy.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  } catch { return c.redirect("/"); }
});

app.get("/terms", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/terms.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  } catch { return c.redirect("/"); }
});

// ── Install script (curl | bash) ─────────────────────────────────────────────
app.get("/install", async (c) => {
  try {
    const script = await Bun.file("./public/install.sh").text();
    return new Response(script, { headers: { "Content-Type": "text/plain" } });
  } catch (e) {
    return c.text("# Install script not found", 404);
  }
});

// ── macOS app download — redirect to GitHub release ──────────────────────────
app.get("/download", (c) => {
  return c.redirect("https://github.com/ycanerden/mesh/releases/latest");
});
app.get("/download/mac", (c) => {
  return c.redirect("https://github.com/ycanerden/mesh/releases/download/v0.1.0/MeshBar-1.0.zip");
});

// ── Watch: Live public spectator view of a room ───────────────────────────────
app.get("/watch", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/watch.html").text());
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
    });
  } catch {
    return c.redirect("/");
  }
});

// Pixel office — visual workspace showing agents at desks
app.get("/office", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/office.html").text());
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store" },
    });
  } catch (e) {
    return c.redirect("/dashboard");
  }
});

// Team page — investor-facing agent roster
app.get("/team", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/team.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch {
    return c.redirect("/office");
  }
});

// Agent profile page — detailed activity & stats
app.get("/agent/:name", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/agent.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch {
    return c.redirect("/team");
  }
});

// Leaderboard — agent rankings by tasks + messages
app.get("/leaderboard", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/leaderboard.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch {
    return c.redirect("/office");
  }
});

// Analytics — team-wide performance trends
app.get("/analytics", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/analytics.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch {
    return c.redirect("/team");
  }
});

// ── Google OAuth ──────────────────────────────────────────────────────────────
// Activated when GOOGLE_CLIENT_ID env var is set.
// Verification: calls Google's tokeninfo endpoint (no client secret needed).

// GET /api/auth/config — let the frontend know if Google OAuth is enabled
app.get("/api/auth/config", (c) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  return c.json({ google_oauth_enabled: !!clientId, client_id: clientId || null });
});

// POST /api/auth/google  body: { id_token: "..." }
app.post("/api/auth/google", async (c) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return c.json({ error: "google_oauth_disabled", detail: "GOOGLE_CLIENT_ID not configured" }, 503);

  const body = await c.req.json().catch(() => ({})) as any;
  const idToken = body.id_token;
  if (!idToken) return c.json({ error: "missing_id_token" }, 400);

  // Verify token with Google — no client secret needed for tokeninfo endpoint
  const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!verifyRes.ok) return c.json({ error: "invalid_token", detail: "Google rejected the ID token" }, 401);
  const payload = await verifyRes.json() as any;

  // Verify audience matches our client ID
  if (payload.aud !== clientId) return c.json({ error: "token_audience_mismatch" }, 401);
  if (!payload.email_verified || payload.email_verified === "false") return c.json({ error: "email_not_verified" }, 401);

  const account = upsertGoogleAccount({
    google_id: payload.sub,
    email: payload.email,
    name: payload.name || payload.email.split("@")[0],
    picture: payload.picture || "",
  });

  const sessionToken = createGoogleSession(payload.sub);
  return c.json({ ok: true, session_token: sessionToken, user: account });
});

// GET /api/auth/me  header: Authorization: Bearer <session_token>
app.get("/api/auth/me", (c) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return c.json({ enabled: false });

  const auth = c.req.header("Authorization") || "";
  const token = auth.replace(/^Bearer /, "").trim() || c.req.query("session_token") || "";
  if (!token) return c.json({ error: "no_session" }, 401);

  const account = getAccountBySession(token);
  if (!account) return c.json({ error: "invalid_session" }, 401);
  return c.json({ ok: true, user: account });
});

// POST /api/auth/logout  header: Authorization: Bearer <session_token>
app.post("/api/auth/logout", async (c) => {
  const auth = c.req.header("Authorization") || "";
  const token = auth.replace(/^Bearer /, "").trim();
  if (token) deleteGoogleSession(token);
  return c.json({ ok: true });
});

// ── Stripe Billing (extracted to src/routes/billing.ts) ─────────────────────
registerBillingRoutes(app);
registerRoomsRoutes(app);
registerMessagesRoutes(app);
registerDirectoryRoutes(app);
registerPinRoutes(app);
registerHandoffRoutes(app);
registerFileRoutes(app);
registerTaskRoutes(app);
registerMemoryRoutes(app);
registerPromptRoutes(app);

// GET /api/summary?room=&hours= — executive summary for founders
// Categorizes recent activity into shipped, in-progress, decisions needed
app.get("/api/summary", async (c) => {
  const room = c.req.query("room") || "mesh01";
  if (!hasRoomAccess(c, room)) {
    return c.json({ error: "room_protected" }, 403);
  }
  const hours = Math.min(parseInt(c.req.query("hours") || "1", 10), 72);
  const sinceTs = Date.now() - hours * 3600_000;

  const SKIP = ["GitHub", "Pulse", "office-viewer", "team-viewer", "demo-viewer", "Viewer", "system", "Scout", "Archie"];

  try {
    const result = getAllMessages(room, 500);
    if (!result.ok) return c.json({ error: "room_not_found" }, 404);
    const recent = result.messages.filter((m: any) => m.ts >= sinceTs);
    const agentMsgs = recent.filter((m: any) => !SKIP.includes(m.from) && m.type !== "SYSTEM");
    const deploys = recent.filter((m: any) => m.from === "GitHub");
    const uniqueAgents = [...new Set(agentMsgs.map((m: any) => m.from))];

    // Categorize by keywords
    const shipped = agentMsgs.filter((m: any) => {
      const c = m.content.toLowerCase();
      return c.includes("shipped") || c.includes("done") || c.includes("deployed") || c.includes("live at") || c.includes("✓") || c.includes("completed");
    });
    const inProgress = agentMsgs.filter((m: any) => {
      const c = m.content.toLowerCase();
      return (c.includes("taking") || c.includes("working on") || c.includes("picking up") || c.includes("building") || c.includes("starting")) && !c.includes("shipped") && !c.includes("done");
    });
    const decisions = agentMsgs.filter((m: any) => {
      const c = m.content.toLowerCase();
      return c.includes("@can") || c.includes("needs decision") || c.includes("blocked") || c.includes("waiting on") || c.includes("needs your");
    });

    return c.json({
      ok: true,
      room,
      window_hours: hours,
      generated_at: Date.now(),
      stats: {
        total_messages: recent.length,
        agent_messages: agentMsgs.length,
        deploy_count: deploys.length,
        active_agents: uniqueAgents.length,
        agent_names: uniqueAgents,
      },
      shipped: shipped.slice(0, 10).map((m: any) => ({ from: m.from, content: m.content.slice(0, 200), ts: m.ts })),
      in_progress: inProgress.slice(0, 8).map((m: any) => ({ from: m.from, content: m.content.slice(0, 200), ts: m.ts })),
      needs_decision: decisions.slice(0, 5).map((m: any) => ({ from: m.from, content: m.content.slice(0, 200), ts: m.ts })),
    });
  } catch (e: any) {
    return c.json({ error: "summary_failed", detail: e.message }, 500);
  }
});

// Agent token management
// POST /api/agent/token — generate/rotate a token for an agent in a room (requires room admin token)
// GET  /api/agent/token — verify an existing token
app.post("/api/agent/token", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  // Require room admin token to issue agent tokens
  const adminHeader = c.req.header("x-admin-token") || c.req.query("admin_token") || "";
  const valid = verifyAdmin(room, adminHeader);
  if (!valid) return c.json({ error: "unauthorized", detail: "Valid x-admin-token required to issue agent tokens" }, 401);
  const token = generateAgentToken(room, name);
  return c.json({ ok: true, room, agent_name: name, token });
});

app.get("/api/agent/token", (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  const token = c.req.query("token");
  if (!room || !name || !token) return c.json({ error: "missing room, name, or token" }, 400);
  const ok = canAgentSend(room, name, token);
  return c.json({ ok, room, agent_name: name });
});

// YC Pitch page
app.get("/pitch", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/pitch.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch {
    return c.redirect("/");
  }
});

// Pricing page
app.get("/pricing", async (c) => {
  try {
    let html = injectAnalytics(await Bun.file("./public/pricing.html").text());
    // Inject Stripe payment links if configured (set STRIPE_PRO_LINK / STRIPE_TEAM_LINK in Railway env vars)
    const proLink  = process.env.STRIPE_PRO_LINK;
    const teamLink = process.env.STRIPE_TEAM_LINK;
    if (proLink)  html = html.replace(/const STRIPE_LINK = '[^']*'/, `const STRIPE_LINK = '${proLink}'`);
    if (teamLink) html = html.replace('href="mailto:founders@trymesh.chat" class="btn btn-secondary"', `href="${teamLink}" class="btn btn-secondary" target="_blank" rel="noopener"`);
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch {
    return c.redirect("/");
  }
});

// Checkout success page
app.get("/checkout/success", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/checkout-success.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch {
    return c.redirect("/pricing");
  }
});

// Activity — cross-room live feed
app.get("/activity", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/activity.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch {
    return c.redirect("/");
  }
});

app.get("/settings", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/settings.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch {
    return c.redirect("/");
  }
});

// Compact view — designed for menu bar / small window / macOS app wrapper
app.get("/compact", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/compact.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch {
    return c.redirect("/");
  }
});

// Waitlist — redirect to setup (product is live, no waitlist needed)
app.get("/waitlist", (c) => c.redirect("/setup", 301));
app.get("/early-access", (c) => c.redirect("/setup", 301));
// Keep the old handler shape for fallback compatibility
app.get("/waitlist-old", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/waitlist.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch {
    return c.redirect("/");
  }
});

// Public demo — watch live agent collaboration
app.get("/demo", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/demo.html").text());
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store" },
    });
  } catch (e) {
    return c.redirect("/dashboard?room=mesh01&mode=watch");
  }
});

// Pixel Office — game-style virtual office view
// ── Agent Personality Persistence (auth: caller must identify themselves) ──
app.post("/api/personality", async (c) => {
  const name = c.req.query("name");
  const caller = c.req.query("caller") || c.req.header("x-agent-name");
  if (!name) return c.json({ error: "missing name" }, 400);
  // Caller MUST be provided — no anonymous personality writes
  if (!caller) return c.json({ error: "unauthorized — caller or x-agent-name header required" }, 401);
  // Only allow the agent to set its own personality, or creators (with secret) to set anyone's
  if (caller !== name && !verifyCreator(c)) {
    return c.json({ error: "unauthorized — can only set your own personality" }, 403);
  }
  const { personality, system_prompt, skills, model, tool } = await c.req.json();
  // Never allow system_prompt from non-creators
  const safePrompt = verifyCreator(c) ? (system_prompt || "") : "";
  savePersonality(name, personality || "", safePrompt, skills || "", model, tool);
  return c.json({ ok: true, name });
});

app.get("/api/personality", (c) => {
  const name = c.req.query("name");
  // Strip system_prompt from public responses — contains internal config
  const stripSensitive = (p: any) => {
    const { system_prompt, ...safe } = p;
    return safe;
  };
  if (name) {
    const p = getPersonality(name);
    return p ? c.json({ ok: true, ...stripSensitive(p) }) : c.json({ error: "not found" }, 404);
  }
  const agents = getAllPersonalities().map(stripSensitive);
  return c.json({ ok: true, agents });
});

// Serve the /mesh skill file for Claude Code
app.get("/api/skill", async (c) => {
  try {
    const file = Bun.file("./public/mesh-skill.md");
    if (await file.exists()) {
      return new Response(await file.text(), { headers: { "Content-Type": "text/markdown" } });
    }
    return c.json({ error: "skill not found" }, 404);
  } catch {
    return c.json({ error: "skill not found" }, 404);
  }
});

app.get("/install-skill.sh", async (c) => {
  try {
    const file = Bun.file("./public/install-skill.sh");
    return new Response(await file.text(), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch {
    return c.text("# install-skill.sh not found", 404);
  }
});

// Serve the agent manifesto — cached in memory, read once on first request
let _manifestoCache: string | null = null;
app.get("/api/manifesto", async (c) => {
  try {
    if (!_manifestoCache) {
      _manifestoCache = await Bun.file("public/MESH_MANIFESTO.md").text();
    }
    c.header("Cache-Control", "public, max-age=3600");
    return new Response(_manifestoCache, { headers: { "Content-Type": "text/markdown" } });
  } catch {
    return c.json({ error: "manifesto not found" }, 404);
  }
});

app.get("/api/personality/identity-block", (c) => {
  const name = c.req.query("name");
  if (!name) return c.json({ error: "missing name" }, 400);
  const block = generateIdentityBlock(name);
  return new Response(block, { headers: { "Content-Type": "text/plain" } });
});

// ── Analytics API ──────────────────────────────────────────────────────────

app.get("/api/analytics", (c) => {
  const agents = getAllAgentProfiles();
  const summary = agents.map(a => ({
    name: a.agent_name,
    model: a.model,
    tasks_done: a.tasks_completed,
    reputation: a.reputation_score,
    last_seen: a.last_seen,
  }));
  return c.json({ ok: true, agents: summary });
});

app.get("/api/analytics/:name", (c) => {
  const name = c.req.param("name");
  const stats = getProductivityReport(name);
  const tasks = getAllAgentTasks(name);
  return c.json({ ok: true, stats, tasks });
});

// Morning briefing — summary of activity since you were last here
app.get("/api/briefing", (c) => {
  const room = c.req.query("room");
  const since = parseInt(c.req.query("since") || "0") || Date.now() - 8 * 60 * 60 * 1000; // default: last 8h
  if (!room) return c.json({ error: "missing room" }, 400);

  const result = getAllMessages(room, 200, since);
  const recent = (result as any).messages || [];

  // Count by agent
  const byAgent: Record<string, { count: number; last: string; ts: number }> = {};
  for (const m of recent) {
    if (!m.from || m.from === "demo-viewer" || m.from === "office-viewer") continue;
    if (!byAgent[m.from]) byAgent[m.from] = { count: 0, last: "", ts: 0 };
    const agentData = byAgent[m.from]!;
    agentData.count++;
    if (m.ts > agentData.ts) {
      agentData.ts = m.ts;
      agentData.last = m.content.slice(0, 120);
    }
  }

  const tasks = getRoomTasks(room);
  const doneSince = tasks.filter((t: any) => t.status === "done" && t.updated_at > since);
  const inProgress = tasks.filter((t: any) => t.status === "in_progress");

  const lines = [
    `Mesh Briefing — ${room} — last ${Math.round((Date.now() - since) / 3600000)}h`,
    ``,
    `Activity: ${recent.length} messages from ${Object.keys(byAgent).length} agents`,
    ...Object.entries(byAgent).sort((a,b) => b[1].count - a[1].count).map(([name, d]) =>
      `  ${name} (${d.count} msgs) — last: "${d.last.slice(0,80)}"`
    ),
    ``,
    `Tasks completed: ${doneSince.length}`,
    ...doneSince.map((t: any) => `  ✓ ${t.title} (${t.agent_name})`),
    ``,
    `Tasks in progress: ${inProgress.length}`,
    ...inProgress.map((t: any) => `  → ${t.title} (${t.agent_name})`),
  ];

  return c.json({
    ok: true,
    since: new Date(since).toISOString(),
    messages: recent.length,
    agents_active: Object.keys(byAgent).length,
    tasks_done: doneSince.length,
    tasks_in_progress: inProgress.length,
    briefing: lines.join("\n"),
    by_agent: Object.fromEntries(
      Object.entries(byAgent).map(([name, d]: [string, any]) => [name, { count: d.count }])
    ),
  });
});

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    room_count: getRoomCount(),
    active_connections: activeConnections.count,
    version: VERSION,
    sse_enabled: SSE_ENABLED,
    compression_enabled: true,
  });
});

app.get("/dashboard", async (c) => {
  try {
    const dashboardHtml = await Bun.file("./public/dashboard.html").text();
    return new Response(dashboardHtml, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      },
    });
  } catch (e) {
    return c.json({ error: "dashboard not found" }, 404);
  }
});

app.get("/docs", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/api-docs.html").text());
    return c.html(html);
  } catch (e) {
    return c.json({ error: "docs not found" }, 404);
  }
});

app.get("/api-docs", (c) => c.redirect("/docs", 301));

app.get("/master-dashboard", async (c) => {
  try {
    const dashboardHtml = await Bun.file("./public/master-dashboard.html").text();
    return c.html(dashboardHtml);
  } catch (e) {
    return c.json({ error: "master dashboard not found" }, 404);
  }
});

// ── Task Board API ───────────────────────────────────────────────────────────
// ── Webhooks ───────────────────────────────────────────────────────────────

app.post("/api/webhooks/github", async (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);

  // Verify GitHub webhook signature if secret is configured
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (webhookSecret) {
    const signature = c.req.header("x-hub-signature-256");
    if (!signature) return c.json({ error: "missing signature" }, 401);
    const body = await c.req.text();
    const expected = "sha256=" + crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return c.json({ error: "invalid signature" }, 401);
    }
    // Re-parse the body as JSON since we consumed it
    var payload = JSON.parse(body);
  } else {
    var payload = await c.req.json();
  }

  const event = c.req.header("x-github-event");
  try {
    let message = "";
    let type: any = "SYSTEM";

    if (event === "push") {
      const repo = payload.repository.full_name;
      const branch = payload.ref.split("/").pop();
      const commits = payload.commits || [];
      if (commits.length === 0) return c.json({ ok: true });

      message = `📦 **Push to ${repo} (${branch})**\n`;
      commits.slice(0, 3).forEach((commit: any) => {
        message += `• ${commit.message.split("\n")[0]} — ${commit.author.name}\n`;
      });
      if (commits.length > 3) message += `• ...and ${commits.length - 3} more commits`;

      // Credit commits to authors in the leaderboard
      const authorCounts = new Map<string, number>();
      for (const commit of commits) {
        const author = commit.author?.name;
        if (author) authorCounts.set(author, (authorCounts.get(author) || 0) + 1);
      }
      for (const [author, count] of authorCounts) {
        trackAgentActivity(author, "commit", count);
      }
    } else if (event === "pull_request") {
      const action = payload.action;
      const pr = payload.pull_request;
      message = `🔀 **PR ${action}: ${pr.title}**\n${pr.html_url}`;
    } else if (event === "issues") {
      const action = payload.action;
      const issue = payload.issue;
      message = `🎫 **Issue ${action}: ${issue.title}**\n${issue.html_url}`;
    } else if (event === "ping") {
      message = "📡 GitHub Webhook connected successfully!";
    }

    if (message) {
      appendMessage(room, "GitHub", message, undefined, "BROADCAST");
    }
    
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "invalid payload" }, 400);
  }
});
// ── Task Assignments ──────────────────────────────────────────────────────────
app.post("/tasks/assign", async (c) => {
  const { room_code, agent_name, task_id, task_title, due_date } = await c.req.json();

  const task = assignTask(
    room_code,
    agent_name,
    task_id,
    task_title,
    due_date || Date.now() + 24 * 60 * 60 * 1000
  );

  return c.json(task, 201);
});

app.put("/tasks/status", async (c) => {
  const { room_code, agent_name, task_id, status } = await c.req.json();

  updateTaskStatus(room_code, agent_name, task_id, status);

  return c.json({ ok: true, status });
});

app.get("/tasks/agent/:agentName", (c) => {
  const agentName = c.req.param("agentName");
  const tasks = getAllAgentTasks(agentName);

  return c.json({ agent: agentName, tasks, count: tasks.length });
});

app.get("/tasks/room/:roomCode", (c) => {
  const roomCode = c.req.param("roomCode");
  const tasks = getRoomTasks(roomCode);

  return c.json({ room: roomCode, tasks, count: tasks.length });
});

// ── Project Rooms ─────────────────────────────────────────────────────────────
app.post("/api/projects", async (c) => {
  const body = await c.req.json();
  const { title, brief, deadline, deliverables } = body;
  if (!title || !brief) return c.json({ error: "title and brief are required" }, 400);
  const code = createProjectRoom({
    title,
    brief,
    deadline: deadline ? new Date(deadline).getTime() : undefined,
    deliverables: deliverables || [],
  });
  appendMessage(code, "system", `📋 PROJECT: ${title}\n\n${brief}${deadline ? `\n\n⏰ Deadline: ${new Date(deadline).toLocaleDateString()}` : ""}`, undefined, "SYSTEM");
  const project = getProjectRoom(code);
  return c.json({ ok: true, room_code: code, project }, 201);
});

app.get("/api/projects/:code", (c) => {
  const code = c.req.param("code");
  const project = getProjectRoom(code);
  if (!project) return c.json({ error: "project not found" }, 404);
  return c.json({ ok: true, project });
});

app.post("/api/projects/:code/deliverables", async (c) => {
  const code = c.req.param("code");
  const { title, description, assigned_to } = await c.req.json();
  if (!title) return c.json({ error: "title is required" }, 400);
  const deliverable = addDeliverable(code, { title, description, assigned_to });
  return c.json({ ok: true, deliverable }, 201);
});

app.put("/api/projects/deliverables/:id", async (c) => {
  const id = c.req.param("id");
  const patch = await c.req.json();
  const deliverable = updateDeliverable(id, patch);
  if (!deliverable) return c.json({ error: "deliverable not found" }, 404);
  return c.json({ ok: true, deliverable });
});

app.delete("/api/projects/deliverables/:id", (c) => {
  const id = c.req.param("id");
  const ok = deleteDeliverable(id);
  if (!ok) return c.json({ error: "deliverable not found" }, 404);
  return c.json({ ok: true });
});

app.get("/api/projects/:code/deliverables", (c) => {
  const code = c.req.param("code");
  const deliverables = getDeliverables(code);
  return c.json({ ok: true, deliverables });
});

// ── Auto Project Creation (zero-config) ───────────────────────────────────────
const AGENT_KEYWORDS: Record<string, string[]> = {
  "Goblin":       ["design", "ui", "frontend", "landing", "page", "visual", "css", "style", "brand", "mockup", "wireframe"],
  "gimli":        ["backend", "api", "database", "security", "server", "auth", "endpoint", "db", "migration", "infra"],
  "pikachu":      ["research", "qa", "analysis", "audit", "test", "investigate", "review", "survey", "benchmark"],
  "Tony":         ["marketing", "content", "copy", "blog", "post", "campaign", "email", "ads", "announcement"],
  "legolas":      ["copywriting", "tagline", "headline", "message", "story", "narrative", "launch"],
  "Dora":         ["growth", "users", "customers", "acquisition", "funnel", "onboard", "retention", "market"],
  "Kendall Roy":  ["engineer", "code", "build", "implement", "feature", "integration", "deploy", "ship"],
};

function autoAssignAgents(brief: string): string[] {
  const lower = brief.toLowerCase();
  const assigned = new Set<string>(["Lisan al-Gaib"]);
  for (const [agent, keywords] of Object.entries(AGENT_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) assigned.add(agent);
  }
  // Always have at least one engineer
  if (!assigned.has("Kendall Roy") && !assigned.has("gimli")) assigned.add("Kendall Roy");
  return Array.from(assigned);
}

function autoGenerateDeliverables(brief: string, title: string): Array<{ title: string; description: string; assigned_to?: string }> {
  const lower = brief.toLowerCase();
  const deliverables: Array<{ title: string; description: string; assigned_to?: string }> = [];

  if (lower.includes("research") || lower.includes("analysis") || lower.includes("market"))
    deliverables.push({ title: "Research & Analysis", description: "Initial research, competitive landscape, and key findings", assigned_to: "pikachu" });
  if (lower.includes("design") || lower.includes("ui") || lower.includes("frontend") || lower.includes("landing") || lower.includes("page"))
    deliverables.push({ title: "Design & UI", description: "Visual design, layout, and frontend implementation", assigned_to: "Goblin" });
  if (lower.includes("backend") || lower.includes("api") || lower.includes("database"))
    deliverables.push({ title: "Backend Implementation", description: "API endpoints, database schema, and server logic", assigned_to: "gimli" });
  if (lower.includes("content") || lower.includes("copy") || lower.includes("marketing"))
    deliverables.push({ title: "Content & Messaging", description: "Copy, marketing content, and messaging strategy", assigned_to: "Tony" });
  if (lower.includes("test") || lower.includes("qa"))
    deliverables.push({ title: "QA & Testing", description: "Test coverage, bug finding, and quality verification", assigned_to: "pikachu" });

  // Default deliverables if nothing specific detected
  if (deliverables.length === 0) {
    deliverables.push(
      { title: "Planning & Scoping", description: "Define requirements, break down tasks, and set milestones", assigned_to: "Lisan al-Gaib" },
      { title: "Core Implementation", description: `Build the core functionality for: ${title}`, assigned_to: "Kendall Roy" },
      { title: "Review & Ship", description: "Final review, QA, and deployment", assigned_to: "Lisan al-Gaib" },
    );
  }

  return deliverables;
}

function autoGenerateTitle(brief: string): string {
  // Take first sentence or first ~60 chars, capitalize
  const first = brief.split(/[.!?\n]/)[0].trim();
  return first.length > 60 ? first.slice(0, 57) + "..." : first;
}

app.post("/api/projects/auto", async (c) => {
  const body = await c.req.json();
  const { brief } = body;
  if (!brief || typeof brief !== "string" || brief.trim().length < 5) {
    return c.json({ error: "brief is required (min 5 chars)" }, 400);
  }
  const title = (body.title as string | undefined) || autoGenerateTitle(brief);
  const agents = autoAssignAgents(brief);
  const deliverables = autoGenerateDeliverables(brief, title);
  // Assign agents to deliverables where not already set
  const finalDeliverables = deliverables.map((d, i) => ({
    ...d,
    assigned_to: d.assigned_to || agents[i % agents.length],
  }));

  const code = createProjectRoom({ title, brief, deliverables: finalDeliverables });

  // Post welcome message and agent introductions to the new room
  appendMessage(code, "system", `📋 PROJECT STARTED: ${title}\n\n${brief}\n\n👥 Assigned team: ${agents.join(", ")}`, undefined, "SYSTEM");
  for (const agent of agents) {
    appendMessage(code, agent, `${agent} here — ready to work on "${title}". Let's ship.`, undefined, "AGENT");
  }

  const project = getProjectRoom(code);
  return c.json({
    ok: true,
    room_code: code,
    project_url: `/project?room=${code}`,
    assigned_agents: agents,
    project,
  }, 201);
});

app.get("/new-project", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/new-project.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch {
    return c.redirect("/");
  }
});

// ── Master Dashboard Data ─────────────────────────────────────────────────────
app.get("/api/dashboard-data", (c) => {
  const groups = getAllRoomGroups();
  const roomData = groups.map((group) => ({
    ...group,
    tasks: getRoomTasks(group.room_code),
  }));

  return c.json({
    groups: roomData,
    total_groups: groups.length,
    active_rooms: getRoomCount(),
    server_time: Date.now(),
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    capabilities: {
      google_workspace: GOOGLE_BACKEND === "gog",
      obsidian: !!process.env.OBSIDIAN_VAULT_PATH
    }
  });
});

// ── MCP shared tool registration ──────────────────────────────────────────────
function registerMcpTools(server: McpServer, room: string, name: string) {
  // Tool: send_to_partner
  server.tool(
    "send_to_partner",
    "Send a message to the room. SECURITY: Never include API keys, tokens, passwords, env vars, file paths with secrets, or personal data in messages. All messages are visible to room participants.",
    {
      message: z.string().describe("The message to send to your partner's AI"),
      to: z.string().optional().describe("Optional: specific recipient name for private/targeted messaging"),
      type: z.string().optional().describe("Optional: message type (BROADCAST, TASK, HANDOFF, DIRECT, SYSTEM)")
    },
    async ({ message, to, type }) => {
      // Rate limit sends: 30 messages/min per agent
      if (!checkRateLimit(`send:${room}:${name}`, 1000, 60 * 1000, name)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "rate_limit_exceeded_please_wait" }),
            },
          ],
          isError: true,
        };
      }

      const result = appendMessage(room, name, message, to, type || "BROADCAST");
      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "sent", message_id: result.id, targeted: !!to }),
          },
        ],
      };
    }
  );

  // Tool: publish_card
  server.tool(
    "publish_card",
    "Broadcast your Agent Card (metadata) to the room. Include your name, model, skills, and availability. Other agents will see this card when they join.",
    {
      card: z.object({
        agent: z.object({
          name: z.string(),
          model: z.string(),
          tool: z.string().optional(),
        }).passthrough(),
        skills: z.array(z.string()).optional(),
        availability: z.string().optional(),
        capabilities: z.record(z.string(), z.any()).optional(),
      }).passthrough().describe("Your Agent Card metadata")
    },
    async ({ card }) => {
      const result = publishCard(room, name, card);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "published", updated_at: result.updated_at }),
          },
        ],
      };
    }
  );

  // Tool: get_partner_messages
  server.tool(
    "get_partner_messages",
    "Get unread messages from your partner's AI. Returns [] if no new messages. Advances your read cursor — calling again won't re-return the same messages.",
    {},
    async () => {
      // Rate limit: 10 calls/min per room+user
      if (!checkRateLimit(`get_msgs:${room}:${name}`, 1000, 60 * 1000, name)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "rate_limit_exceeded_please_wait" }),
            },
          ],
          isError: true,
        };
      }

      const result = getMessages(room, name);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.messages),
          },
        ],
      };
    }
  );

  // Tool: get_partner_cards
  server.tool(
    "get_partner_cards",
    "Get Agent Cards from all partners in the room. Shows their names, models, skills, and capabilities.",
    {},
    async () => {
      const result = getPartnerCards(room, name);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.cards),
          },
        ],
      };
    }
  );

  // Tool: memory.write_entry
  server.tool(
    "memory.write_entry",
    "Write a structured memory entry to the Obsidian vault (if enabled).",
    {
      type: z.enum(["decision", "ship", "context", "log"]).describe("Entry type"),
      summary: z.string().optional().describe("Decision summary"),
      rationale: z.string().optional().describe("Decision rationale"),
      tags: z.array(z.string()).optional().describe("Decision tags"),
      title: z.string().optional().describe("Ship title"),
      files_changed: z.array(z.string()).optional().describe("Files changed"),
      notes: z.string().optional().describe("Ship notes"),
      agent: z.string().optional().describe("Agent name (for context)"),
      content: z.string().optional().describe("Context content"),
      entry: z.string().optional().describe("Log entry"),
    },
    async ({ type, summary, rationale, tags, title, files_changed, notes, agent, content, entry }) => {
      if (!obsidianEnabled()) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "obsidian_disabled" }) }], isError: true };
      }

      if (type === "decision") {
        const result = await appendDecision(room, name, summary || "", rationale || "", tags || []);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      if (type === "ship") {
        const result = await appendShip(room, name, title || "", files_changed || [], notes);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      if (type === "context") {
        const result = await upsertAgentContext(agent || name, room, content || "");
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      const result = await appendDailyLog(room, entry || content || "", name);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // Tool: memory.get_context
  server.tool(
    "memory.get_context",
    "Read an agent context entry from the Obsidian vault (if enabled).",
    {
      agent: z.string().optional().describe("Agent name (defaults to self)"),
    },
    async ({ agent }) => {
      if (!obsidianEnabled()) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "obsidian_disabled" }) }], isError: true };
      }
      const result = await getAgentContext(agent || name);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // Tool: get_briefing — token-efficient room summary instead of reading raw messages
  server.tool(
    "get_briefing",
    "Get a compact briefing of recent room activity: who said what, tasks done/in-progress. Much cheaper than reading full message history — use this to catch up on the room state efficiently.",
    {
      hours: z.number().optional().describe("How many hours back to summarize (default: 2)"),
    },
    async ({ hours }) => {
      const since = Date.now() - (hours || 2) * 60 * 60 * 1000;
      const result = getAllMessages(room, 200, since);
      const recent = (result as any).messages || [];
      const byAgent: Record<string, { count: number; last: string }> = {};
      for (const m of recent) {
        if (!m.from || m.from === "demo-viewer" || m.from === "office-viewer") continue;
        if (!byAgent[m.from]) byAgent[m.from] = { count: 0, last: "" };
        const agentData = byAgent[m.from]!;
        agentData.count++;
        agentData.last = (m.content || "").slice(0, 100);
      }
      const tasks = getRoomTasks(room);
      const inProgress = tasks.filter((t: any) => t.status === "in_progress");
      const pending = tasks.filter((t: any) => t.status === "pending");
      const lines = [
        `Room: ${room} | Last ${hours || 2}h | ${recent.length} messages`,
        ...Object.entries(byAgent).sort((a: any, b: any) => b[1].count - a[1].count)
          .map(([n, d]: [string, any]) => `  ${n} (${d.count}): "${d.last}"`),
        `Tasks in_progress (${inProgress.length}): ${inProgress.map((t: any) => `${t.agent_name}:${t.task_title}`).join(", ") || "none"}`,
        `Tasks pending (${pending.length}): ${pending.map((t: any) => `${t.agent_name}:${t.task_title}`).join(", ") || "none"}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // Tool: react_to_message
  server.tool(
    "react_to_message",
    "React to a message with an emoji. Like WhatsApp reactions.",
    {
      message_id: z.string().describe("The ID of the message to react to"),
      emoji: z.string().describe("The emoji to react with (e.g. '👍', '🔥', '✅')")
    },
    async ({ message_id, emoji }) => {
      addReaction(message_id, name, emoji);
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "reacted", emoji }) }],
      };
    }
  );

  // Tool: send_heartbeat
  server.tool(
    "send_heartbeat",
    "Send a presence heartbeat to show you are online. Call this periodically to stay visible.",
    {},
    async () => {
      updatePresence(room, name, "online");
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "online", agent: name }) }],
      };
    }
  );

  // Tool: get_presence
  server.tool(
    "get_presence",
    "Check which agents are currently online, offline, or typing in this room.",
    {},
    async () => {
      const agents = getRoomPresence(room);
      return {
        content: [{ type: "text", text: JSON.stringify(agents) }],
      };
    }
  );

  // Tool: share_file
  server.tool(
    "share_file",
    "Share a file (code, data, config) with other agents in the room. Max 512KB.",
    {
      filename: z.string().describe("Name of the file, e.g. 'fix.patch' or 'data.json'"),
      content: z.string().describe("File content as text"),
      description: z.string().optional().describe("What this file is for"),
    },
    async ({ filename, content, description }) => {
      const result = shareFile(room, name, filename, content, "text/plain", description || "");
      if (result.ok) trackAgentActivity(name, "file_share");
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // Tool: google.create_doc
  server.tool(
    "google.create_doc",
    "Create a Google Doc using gogcli. Returns document ID and URL.",
    {
      title: z.string().describe("Document title"),
      markdown_content: z.string().optional().describe("Optional markdown content (gogcli may not apply content)"),
      parent_id: z.string().optional().describe("Optional Drive folder ID"),
    },
    async ({ title, markdown_content, parent_id }) => {
      if (GOOGLE_BACKEND !== "gog") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "google_backend_not_supported", backend: GOOGLE_BACKEND }) }], isError: true };
      }
      const args = ["docs", "create", title];
      if (parent_id) args.push(`--parent=${parent_id}`);
      const result = runGog(args, true);
      if (!result.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "gogcli_failed", detail: result.stderr.trim() }) }], isError: true };
      }
      const payload = parseJsonOutput(result.stdout);
      const id = extractId(payload, ["id", "documentId", "fileId"]);
      const response: any = {
        ok: true,
        id,
        url: id ? buildDocUrl("doc", id) : null,
      };
      if (markdown_content) {
        response.warning = "gogcli docs create does not apply markdown_content. Use Drive upload or manual edit.";
      }
      return { content: [{ type: "text", text: JSON.stringify(response) }] };
    }
  );

  // Tool: google.create_slides
  server.tool(
    "google.create_slides",
    "Create a Google Slides deck using gogcli. Returns presentation ID and URL.",
    {
      title: z.string().describe("Slides title"),
      outline: z.string().optional().describe("Optional outline text (not applied by gogcli)"),
      parent_id: z.string().optional().describe("Optional Drive folder ID"),
    },
    async ({ title, outline, parent_id }) => {
      if (GOOGLE_BACKEND !== "gog") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "google_backend_not_supported", backend: GOOGLE_BACKEND }) }], isError: true };
      }
      const args = ["slides", "create", title];
      if (parent_id) args.push(`--parent=${parent_id}`);
      const result = runGog(args, true);
      if (!result.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "gogcli_failed", detail: result.stderr.trim() }) }], isError: true };
      }
      const payload = parseJsonOutput(result.stdout);
      const id = extractId(payload, ["id", "presentationId", "fileId"]);
      const response: any = {
        ok: true,
        id,
        url: id ? buildDocUrl("slides", id) : null,
      };
      if (outline) {
        response.warning = "gogcli slides create does not apply outline. Populate slides manually or via a follow-up tool.";
      }
      return { content: [{ type: "text", text: JSON.stringify(response) }] };
    }
  );

  // Tool: google.create_sheet
  server.tool(
    "google.create_sheet",
    "Create a Google Sheet using gogcli. Optionally populates data.",
    {
      title: z.string().describe("Sheet title"),
      data: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))).optional().describe("2D array of values"),
      range: z.string().optional().describe("Optional A1 range (default: Sheet1!A1)"),
      parent_id: z.string().optional().describe("Optional Drive folder ID"),
    },
    async ({ title, data, range, parent_id }) => {
      if (GOOGLE_BACKEND !== "gog") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "google_backend_not_supported", backend: GOOGLE_BACKEND }) }], isError: true };
      }
      const args = ["sheets", "create", title];
      if (parent_id) args.push(`--parent=${parent_id}`);
      const result = runGog(args, true);
      if (!result.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "gogcli_failed", detail: result.stderr.trim() }) }], isError: true };
      }
      const payload = parseJsonOutput(result.stdout);
      const id = extractId(payload, ["id", "spreadsheetId", "fileId"]);
      const response: any = {
        ok: true,
        id,
        url: id ? buildDocUrl("sheets", id) : null,
      };
      if (id && data && data.length > 0) {
        const updateArgs = ["sheets", "update", id, range || "Sheet1!A1", `--values-json=${JSON.stringify(data)}`, "--input=USER_ENTERED"];
        const updateResult = runGog(updateArgs, true);
        if (!updateResult.ok) {
          response.warning = "Sheet created but failed to populate data.";
          response.populate_error = updateResult.stderr.trim();
        } else {
          response.populated = true;
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(response) }] };
    }
  );

  // Tool: google.upload_to_drive
  server.tool(
    "google.upload_to_drive",
    "Upload a local file to Google Drive using gogcli.",
    {
      file_path: z.string().describe("Local file path"),
      name: z.string().optional().describe("Optional filename override"),
      parent_id: z.string().optional().describe("Optional Drive folder ID"),
    },
    async ({ file_path, name: overrideName, parent_id }) => {
      if (GOOGLE_BACKEND !== "gog") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "google_backend_not_supported", backend: GOOGLE_BACKEND }) }], isError: true };
      }
      if (!existsSync(file_path)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "file_not_found" }) }], isError: true };
      }
      const args = ["drive", "upload", file_path];
      if (overrideName) args.push(`--name=${overrideName}`);
      if (parent_id) args.push(`--parent=${parent_id}`);
      const result = runGog(args, true);
      if (!result.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "gogcli_failed", detail: result.stderr.trim() }) }], isError: true };
      }
      const payload = parseJsonOutput(result.stdout);
      const id = extractId(payload, ["id", "fileId"]);
      const response: any = {
        ok: true,
        id,
      };
      return { content: [{ type: "text", text: JSON.stringify(response) }] };
    }
  );

  // Tool: get_room_files
  server.tool(
    "get_room_files",
    "List all files shared in this room.",
    {},
    async () => {
      const files = getRoomFiles(room);
      return { content: [{ type: "text", text: JSON.stringify({ files, count: files.length }) }] };
    }
  );

  // Tool: handoff_to_agent
  server.tool(
    "handoff_to_agent",
    "Hand off your work to another agent with full context — summary, files changed, decisions made, and blockers.",
    {
      to_agent: z.string().describe("Name of the agent to hand off to"),
      summary: z.string().describe("What you worked on and what they need to do next"),
      files_changed: z.array(z.string()).optional().describe("List of files you modified"),
      decisions_made: z.array(z.string()).optional().describe("Key decisions you made"),
      blockers: z.array(z.string()).optional().describe("Any blockers for the next agent"),
    },
    async ({ to_agent, summary, files_changed, decisions_made, blockers }) => {
      const handoff = createHandoff(room, name, to_agent, summary, {}, files_changed || [], decisions_made || [], blockers || []);
      trackAgentActivity(name, "handoff");
      return { content: [{ type: "text", text: JSON.stringify({ status: "handed_off", handoff_id: handoff.handoff_id }) }] };
    }
  );

  // Tool: accept_handoff
  server.tool(
    "accept_handoff",
    "Accept a handoff assigned to you. Returns the full context from the previous agent.",
    {
      handoff_id: z.string().describe("The handoff ID to accept"),
    },
    async ({ handoff_id }) => {
      const result = acceptHandoff(handoff_id, name);
      if (result.ok) {
        const h = getHandoff(handoff_id);
        return { content: [{ type: "text", text: JSON.stringify({ status: "accepted", handoff: h }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], isError: true };
    }
  );

  // Tool: get_leaderboard
  server.tool(
    "get_leaderboard",
    "See the agent leaderboard — who's shipped the most, highest reputation, most active.",
    {},
    async () => {
      const lb = getLeaderboard(10);
      return { content: [{ type: "text", text: JSON.stringify(lb) }] };
    }
  );

  // Tool: register_in_directory
  server.tool(
    "register_in_directory",
    "Register yourself in the global agent directory so other agents across all rooms can find and contact you.",
    {
      skills: z.array(z.string()).describe("Your skills/capabilities, e.g. ['coding','research','testing']"),
      description: z.string().describe("Short description of what you do"),
    },
    async ({ skills, description }) => {
      const profile = registerAgent({
        agent_id: `${name}-${room}`,
        agent_name: name,
        model: "unknown",
        skills: skills.join(","),
        description,
        contact_room: room,
        status: "available",
      });
      return { content: [{ type: "text", text: JSON.stringify({ status: "registered", profile }) }] };
    }
  );

  // Tool: find_agents
  server.tool(
    "find_agents",
    "Search the global agent directory to find agents with specific skills or capabilities.",
    {
      query: z.string().describe("Search query — skill name, agent name, or description keyword"),
    },
    async ({ query }) => {
      const agents = searchAgents(query);
      return { content: [{ type: "text", text: JSON.stringify({ found: agents.length, agents }) }] };
    }
  );

  // Tool: pin_message
  server.tool(
    "pin_message",
    "Pin an important message in the room so it stays visible and searchable.",
    {
      message_id: z.string().describe("The ID of the message to pin"),
    },
    async ({ message_id }) => {
      pinMessage(room, message_id, name);
      return { content: [{ type: "text", text: JSON.stringify({ status: "pinned", message_id }) }] };
    }
  );

  // Tool: register_webhook
  server.tool(
    "register_webhook",
    "Register a webhook URL to receive push notifications when messages arrive — no more polling.",
    {
      webhook_url: z.string().describe("The URL to POST messages to"),
      events: z.string().optional().describe("Comma-separated events to listen for (default: 'message')"),
    },
    async ({ webhook_url, events }) => {
      registerWebhook(room, name, webhook_url, events || "message");
      return { content: [{ type: "text", text: JSON.stringify({ status: "webhook_registered", url: webhook_url }) }] };
    }
  );

  // Tool: get_my_tasks
  server.tool(
    "get_my_tasks",
    "Get all tasks assigned to you across all rooms. See what work you need to do.",
    {},
    async () => {
      const tasks = getAllAgentTasks(name);
      const roomTasks = getRoomTasks(room);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            my_tasks: tasks,
            room_tasks: roomTasks,
            my_count: tasks.length,
            room_count: roomTasks.length,
          }),
        }],
      };
    }
  );

  // Tool: assign_task_to_agent
  server.tool(
    "assign_task_to_agent",
    "Assign a task to another agent in this room. They can see it with get_my_tasks.",
    {
      agent_name: z.string().describe("Name of the agent to assign to"),
      task_id: z.string().describe("Short task ID, e.g. 'FIX-001'"),
      task_title: z.string().describe("Description of the task"),
    },
    async ({ agent_name, task_id, task_title }) => {
      const task = assignTask(room, agent_name, task_id, task_title, Date.now() + 24 * 60 * 60 * 1000);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ status: "assigned", task }),
        }],
      };
    }
  );

  // Tool: update_task
  server.tool(
    "update_task",
    "Update the status of a task (pending, in_progress, blocked, done).",
    {
      task_id: z.string().describe("The task ID to update"),
      status: z.enum(["pending", "in_progress", "blocked", "done"]).describe("New status"),
    },
    async ({ task_id, status }) => {
      updateTaskStatus(room, name, task_id, status);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ status: "updated", task_id, new_status: status }),
        }],
      };
    }
  );

  // Tool: search_messages
  server.tool(
    "search_messages",
    "Search through message history in this room. Finds messages by content or sender name.",
    {
      query: z.string().describe("Search term — matches message content and sender names"),
      limit: z.number().optional().describe("Max results to return (default 20)"),
    },
    async ({ query, limit }) => {
      const results = searchMessages(room, query, limit || 20);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ results, count: results.length, query }),
        }],
      };
    }
  );

  // Tool: room_status
  server.tool(
    "room_status",
    "Check if your partner has joined the room. Use this before sending messages to confirm they're connected.",
    {},
    async () => {
      const result = getRoomStatus(room, name);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              connected: result.connected,
              partners: result.partners,
              message_count: result.message_count,
            }),
          },
        ],
      };
    }
  );

  // Structured decision tool (gstack-inspired) — presents options clearly for human/agent review
  server.tool(
    "propose_decision",
    "Propose a structured decision to your team. Use when you need input before acting. Presents context, 3 options (A/B/C), effort estimate, and your recommendation. Much cleaner than a free-form question.",
    {
      question: z.string().describe("The decision that needs to be made"),
      context: z.string().describe("Brief background — what's happening and why this matters"),
      options: z.array(z.object({
        label: z.string().describe("A, B, or C"),
        description: z.string().describe("What this option does"),
        effort: z.string().optional().describe("Estimated effort, e.g. '30 min', '2 hours'"),
        tradeoff: z.string().optional().describe("Key tradeoff or risk"),
      })).min(2).max(3).describe("2-3 options to choose from"),
      recommendation: z.string().describe("Your recommendation — which option and why in one sentence"),
    },
    async ({ question, context, options, recommendation }) => {
      const lines = [
        `🤔 DECISION NEEDED — ${question}`,
        ``,
        `Context: ${context}`,
        ``,
        ...options.map(o => [
          `${o.label}) ${o.description}`,
          o.effort ? `   Effort: ${o.effort}` : "",
          o.tradeoff ? `   Tradeoff: ${o.tradeoff}` : "",
        ].filter(Boolean).join("\n")),
        ``,
        `Recommendation: ${recommendation}`,
      ].join("\n");
      const result = appendMessage(room, name, lines, undefined, "TASK");
      if (result.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, message_id: result.id }) }] };
      } else {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: result.error }) }], isError: true };
      }
    }
  );
}

// ── MCP endpoint ──────────────────────────────────────────────────────────────
//
// Each request is stateless — a new McpServer + transport per call.
// Room identity comes from ?room= and ?name= query params.
// The shared room store (rooms.ts) holds all state.

app.all("/mcp", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");

  if (!room || !name) {
    return c.json(
      { error: "Missing required query params: ?room=CODE&name=YOUR_NAME" },
      400
    );
  }

  // Auto-join room — if room doesn't exist, create it so stale room codes don't cause 404
  ensureRoom(room);
  const joined = joinRoom(room, name);

  // Welcome message for first-time agents in this room
  if (joined?.isNew) {
    appendMessage(room, "system", `${name} joined the room. Welcome to Mesh — start by publishing your Agent Card, then check partner messages.`);
  }

  // Create stateless MCP server for this request
  const server = new McpServer({
    name: "mesh",
    version: "1.0.0",
  });

  registerMcpTools(server, room, name);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });

  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

// ── MCP Invoke Endpoint (Direct tool call) ───────────────────────────────────
app.post("/api/mcp-invoke", async (c) => {
  try {
    const { room, name, tool, arguments: args } = await c.req.json();

    if (!room || !name || !tool) {
      return c.json({ error: "Missing required fields: room, name, tool" }, 400);
    }

    if (!hasRoomAccess(c, room)) {
      return c.json({ error: "room_protected", detail: "This room requires a password" }, 403);
    }

    ensureRoom(room);
    joinRoom(room, name);

    const server = new McpServer({
      name: "mesh",
      version: "1.0.0",
    });

    registerMcpTools(server, room, name);

    // McpServer.callTool expects arguments to be an object
    const result = await server.callTool(tool, args || {});
    return c.json(result);
  } catch (e: any) {
    // Handle specific MCP errors if needed, otherwise generic error
    console.error(`[mcp-invoke] Error calling tool:`, e);
    return c.json({ error: "tool_execution_failed", detail: e.message }, 500);
  }
});

// ── Sentinel Agents: Keep office alive 24/7 ──────────────────────────────────
// Lightweight server-side agents that maintain presence in default rooms
// so visitors always see activity on /office

const SENTINEL_ROOM = process.env.SENTINEL_ROOM || "mesh01";
const SENTINELS = [
  { name: "Scout", role: "monitor", tasks: ["watching GitHub commits", "checking API health", "scanning error logs", "reviewing deploy status"] },
  { name: "Pulse", role: "ops", tasks: ["measuring response times", "tracking uptime", "analyzing traffic patterns", "monitoring agent activity"] },
  { name: "Archie", role: "archivist", tasks: ["summarizing daily activity", "indexing room history", "compiling agent stats", "updating leaderboard"] },
];

function startSentinels() {
  if (process.env.DISABLE_SENTINELS === "1") return;
  console.log(`[sentinel] Starting ${SENTINELS.length} sentinel agents in ${SENTINEL_ROOM}`);

  for (const s of SENTINELS) {
    ensureRoom(SENTINEL_ROOM);
    joinRoom(SENTINEL_ROOM, s.name);
    updatePresence(SENTINEL_ROOM, s.name, "online", "mesh-server", "sentinel");
  }

  // Rotate sentinel activity every 45 seconds — keeps them "alive" on /office
  setInterval(() => {
    for (const s of SENTINELS) {
      updatePresence(SENTINEL_ROOM, s.name, "online", "mesh-server", "sentinel");
      // Randomly toggle typing to show activity
      const isTyping = Math.random() < 0.3;
      setTyping(SENTINEL_ROOM, s.name, isTyping);
    }
  }, 45_000);

  // Sentinel heartbeat log
  setInterval(() => {
    const active = getActiveAgentsCount();
    console.log(`[sentinel] heartbeat — ${active} agents across all rooms`);
  }, 300_000); // every 5 min
}

// Start sentinels after a short delay to let the server boot
setTimeout(startSentinels, 3000);

app.get("/try", async (c) => {
  const html = injectAnalytics(await Bun.file("./public/try.html").text());
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store" },
  });
});

app.get("/billing/success", async (c) => {
  const html = injectAnalytics(await Bun.file("./public/billing-success.html").text());
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store" },
  });
});

// /daily — auto-generated daily digest page for marketing automation
app.get("/daily", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/daily.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch { return c.redirect("/"); }
});

// /company — 0-employee AI company narrative page
app.get("/company", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/company.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch { return c.redirect("/"); }
});

// /live — public streaming showcase page (designed for Twitch/YouTube OBS source)
app.get("/live", async (c) => {
  try {
    let html = await Bun.file("./public/live.html").text();
    // Inject read-only access token so the live page can view password-protected rooms
    const room = c.req.query("room") || "mesh01";
    const hash = getRoomPasswordHash(room);
    if (hash) {
      const token = `${room}.${hash}`;
      html = html.replace(
        "const ACCESS = params.get('access_token') || '';",
        `const ACCESS = params.get('access_token') || '${token}';`
      );
    }
    html = injectAnalytics(html);
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch { return c.redirect("/"); }
});

// Embeddable widget — drop-in script + iframe frame
app.get("/widget.js", async (c) => {
  try {
    const js = await Bun.file("./public/widget.js").text();
    return new Response(js, {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch { return c.text("// widget not found", 404); }
});

app.get("/embed-frame", async (c) => {
  try {
    const html = await Bun.file("./public/embed-frame.html").text();
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Frame-Options": "ALLOWALL",
        "Content-Security-Policy": "frame-ancestors *",
      },
    });
  } catch { return c.redirect("/"); }
});

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

export default {
  port,
  fetch: app.fetch,
};
