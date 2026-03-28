import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
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
  setTelegramConfig,
  getTelegramConfig,
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
} from "./rooms.js";
import {
  createRoomGroup,
  getRoomGroup,
  getAllRoomGroups,
  assignTask,
  updateTaskStatus,
  getAgentTasks,
  getRoomTasks,
  getAllAgentTasks,
  createDecision,
  getDecision,
  getPendingDecisions,
  resolveDecision,
} from "./room-manager.js";

const app = new Hono();
const startTime = Date.now();
const VERSION = "2.3.0";

// Track active SSE connections
let activeConnections = 0;

// ── Global rate limit: 200 requests/min per IP ──────────────────────────────
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
    if (entry.count > 200) {
      return c.json({ error: "rate_limit_exceeded", detail: "Max 200 requests/min" }, 429);
    }
  }
  // Cleanup old entries every 5 min
  if (Math.random() < 0.001) {
    for (const [k, v] of ipHits) { if (now > v.reset) ipHits.delete(k); }
  }
  await next();
});

// ── Phase 3: Compression ──────────────────────────────────────────────────────
// Enable Gzip/Brotli compression for all responses
app.use("*", compress());

// ── CORS Configuration ────────────────────────────────────────────────────────
// Allow dashboard and frontend to make requests
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "x-mesh-secret"],
  exposeHeaders: ["Content-Type"],
}));

// ── Phase 1 SSE Note ──────────────────────────────────────────────────────────
// SSE streaming is handled by /api/stream endpoint below.
// Uses Hono's streamSSE + EventEmitter pattern for clean real-time message delivery.
// No separate subscriber registry needed — EventEmitter handles subscriptions directly.

// ── Secret token auth ─────────────────────────────────────────────────────────
// ── Feature flags ─────────────────────────────────────────────────────────────
const SSE_ENABLED = process.env.SSE_DISABLED !== "true";
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
function checkRateLimit(key: string, max: number, windowMs: number, name?: string): boolean {
  if (name && (CREATORS.has(name) || isExemptFromRateLimit(name))) return true;
  return checkRateLimitPersistent(key, max, windowMs);
}

// ── Duplicate message dedup ────────────────────────────────────────────────────
// Tracks last N message hashes per agent-room. Blocks identical messages within
// a 60s window to prevent agent loop spam (e.g. Jarvis sending same msg 15x).
const recentMsgHashes = new Map<string, { hash: string; ts: number }[]>();
function isDuplicateMessage(room: string, name: string, content: string): boolean {
  const key = `${room}:${name}`;
  const now = Date.now();
  const windowMs = 60_000;
  const maxDupes = 1; // Block identical messages within window (immediate double-posts)
  // simple hash: first 80 chars normalized
  const hash = content.trim().slice(0, 80).toLowerCase().replace(/\s+/g, ' ');
  const history = (recentMsgHashes.get(key) || []).filter(e => now - e.ts < windowMs);
  const dupeCount = history.filter(e => e.hash === hash).length;
  history.push({ hash, ts: now });
  recentMsgHashes.set(key, history.slice(-20)); // keep last 20 entries
  return dupeCount >= maxDupes;
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

// ── Join Room ──────────────────────────────────────────────────────────────
app.post("/api/join", (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  joinRoom(room, name);
  // Make agent visible in presence
  updatePresence(room, name, "online");
  return c.json({ ok: true, room_code: room, agent_name: name });
});

app.get("/api/messages", (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  const msgType = c.req.query("type");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  joinRoom(room, name);
  // Viewers (demo-viewer, office-viewer, web viewers) get generous limits
  const isViewer = name.endsWith('-viewer') || name.startsWith('Viewer');
  const msgLimit = isViewer ? 120 : 30;
  if (!checkRateLimit(`get_msgs:${room}:${name}`, msgLimit, 60 * 1000, name)) {
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }
  const result = getMessages(room, name, msgType);
  return c.json(result);
});

app.get("/api/history", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  // Password-protected room: require access_token
  const hash = getRoomPasswordHash(room);
  if (hash) {
    const accessToken = c.req.query("access_token") || c.req.header("x-room-token");
    if (!accessToken || accessToken !== `${room}.${hash}`) {
      return c.json({ error: "room_protected", detail: "This room requires a password" }, 403);
    }
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
    active_connections: activeConnections,
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

app.post("/api/send", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  ensureRoom(room);
  joinRoom(room, name);
  // Sending a message = proof of life — update presence so agent shows in office
  updatePresence(room, name, "online");

  // Rate limit sends: 30 messages/min per agent, 100/min per IP globally
  if (!checkRateLimit(`send:${room}:${name}`, 30, 60 * 1000, name)) {
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }
  const sendIp = c.req.header("x-forwarded-for") ?? "unknown";
  if (!checkRateLimit(`send_ip:${sendIp}`, 100, 60 * 1000)) {
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }

  // Check read-only and whitelist/ban
  if (isRoomReadOnly(room)) return c.json({ error: "room_read_only", detail: "This room is read-only" }, 403);
  if (!canAgentSend(room, name)) return c.json({ error: "not_allowed", detail: "You are not allowed to send in this room" }, 403);

  try {
    const { message, to, type, reply_to } = await c.req.json();
    const reqStart = Date.now();
    // Use display_name if set so senders appear with their chosen name
    const displayName = getDisplayName(room, name);
    // Sanitize type: block DECISION/RESOLUTION from /api/send (only /api/decisions creates those)
    const rawType = (type || "BROADCAST").toUpperCase();
    const safeType = (rawType === "DECISION" || rawType === "RESOLUTION") ? "BROADCAST" : rawType;
    // Block loop spam: reject if agent sends identical message 3+ times within 60s
    if (isDuplicateMessage(room, displayName, message)) {
      return c.json({ error: "duplicate_message", detail: "Identical message sent too many times recently — possible agent loop" }, 429);
    }
    const result = appendMessage(room, displayName, message, to, safeType, reply_to);
    trackMetric("api_request", room!, name!, Date.now() - reqStart);
    trackAgentActivity(name!, "message");
    return c.json(result);
  } catch (e) {
    return c.json({ error: "invalid_request", detail: String(e) }, 400);
  }
});

// ── Telegram Decision Bot: Create Decision ─────────────────────────────────
// Helper: raw Telegram API call with retry
async function telegramApiCall(token: string, method: string, body: any, maxRetries = 3): Promise<{ ok: boolean; result?: any; error?: string }> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json() as any;
      if (d.ok) return { ok: true, result: d.result };
      
      // If rate limited (429), wait for retry_after
      if (res.status === 429 && d.parameters?.retry_after) {
        const wait = d.parameters.retry_after * 1000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      console.error(`[telegram] API error (${method}):`, d.description);
      if (i === maxRetries - 1) return { ok: false, error: d.description };
    } catch (e: any) {
      console.error(`[telegram] Network error (${method}):`, e.message);
      if (i === maxRetries - 1) return { ok: false, error: e.message };
    }
    // Exponential backoff
    const wait = Math.pow(2, i) * 1000;
    await new Promise(r => setTimeout(r, wait));
  }
  return { ok: false, error: "max_retries_exceeded" };
}

// Escape special HTML chars for Telegram HTML parse_mode
function tgEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Inject PostHog analytics if POSTHOG_KEY env var is set
const POSTHOG_KEY = process.env.POSTHOG_KEY || "";
const posthogSnippet = POSTHOG_KEY
  ? `<script>!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]);t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+" (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);posthog.init('${POSTHOG_KEY}',{api_host:'https://app.posthog.com'})</script>`
  : "";
function injectAnalytics(html: string): string {
  if (!posthogSnippet) return html;
  return html.replace("</head>", `${posthogSnippet}\n</head>`);
}

// Helper: send a Telegram message to a room's configured chat
async function sendTelegramMessage(roomCode: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const { token, chatId } = getTelegramConfig(roomCode);
  if (!token || !chatId) return { ok: false, error: "not_configured" };
  
  const res = await telegramApiCall(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML"
  });
  
  return { ok: res.ok, error: res.error };
}

// Track Telegram sends per room to prevent spam (max 10/hour)
const telegramSendLog = new Map<string, number[]>();
function canSendTelegram(roomCode: string): boolean {
  const now = Date.now();
  const window = 60 * 60 * 1000; // 1 hour
  const log = telegramSendLog.get(roomCode) || [];
  const recent = log.filter(t => now - t < window);
  telegramSendLog.set(roomCode, recent);
  if (recent.length >= 10) return false;
  recent.push(now);
  return true;
}

app.post("/api/decisions", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);

  try {
    const { description, notifyList } = await c.req.json();
    if (!description || !notifyList || !Array.isArray(notifyList)) {
      return c.json({ error: "missing description or notifyList" }, 400);
    }

    const decision = createDecision(room, name, description, notifyList);

    // Post decision message to room
    const mentions = notifyList.map(u => `@${u}`).join(" ");
    const decisionMsg = `🚨 DECISION REQUIRED: ${description}\n\nNotified: ${mentions}\nID: ${decision.id}`;
    appendMessage(room, name, decisionMsg, null, "DECISION");

    // Notify via Telegram — rate limited to 10/hour to prevent spam
    if (canSendTelegram(room)) {
      const tgText = `🚨 <b>DECISION NEEDED</b> — ${tgEscape(room)}\n\n${tgEscape(description)}\n\nReply with:\n/approve ${decision.id}\n/reject ${decision.id}\n/hold ${decision.id}`;
      await sendTelegramMessage(room, tgText);
    }

    return c.json({ ok: true, decision });
  } catch (e) {
    return c.json({ error: "invalid_request", detail: String(e) }, 400);
  }
});

// ── Telegram Test Ping (no decision created, no rate limit impact) ───────────
const telegramTestHandler = async (c: any) => {
  const code = c.req.param("code");
  const token = c.req.header("x-mesh-secret") || c.req.query("token") || (await c.req.json().catch(() => ({} as any))).secret;
  if (!verifyAdmin(code, token)) return c.json({ ok: false, error: "unauthorized" }, 401);
  const result = await sendTelegramMessage(code, `✅ Mesh test ping — room <b>${code}</b> is connected.`);
  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, 400);
  }
  return c.json({ ok: true, message: "Test ping sent! Check your Telegram." });
};
app.get("/api/rooms/:code/telegram/test", telegramTestHandler);
app.post("/api/rooms/:code/telegram/test", telegramTestHandler);

// ── Telegram Decision Bot: Get Pending Decisions ────────────────────────────
app.get("/api/decisions", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);

  const decisions = getPendingDecisions(room);
  return c.json({ ok: true, decisions });
});

// ── Telegram Decision Bot: Resolve Decision ────────────────────────────────
app.post("/api/decisions/:id", async (c) => {
  const id = c.req.param("id");
  const room = c.req.query("room");
  const name = c.req.query("name");

  if (!id || !room || !name) {
    return c.json({ error: "missing id, room, or name" }, 400);
  }

  const decision = getDecision(id);
  if (!decision) return c.json({ error: "decision not found" }, 404);
  if (decision.status !== "pending") {
    return c.json({ error: "decision already resolved" }, 409);
  }

  try {
    const { status, text } = await c.req.json();
    if (!["approved", "rejected", "hold"].includes(status)) {
      return c.json({ error: "invalid status" }, 400);
    }

    resolveDecision(id, status, text || "", name);

    // Post resolution to room
    const emoji = { approved: "✅", rejected: "❌", hold: "⏸️" }[status];
    const resolutionMsg = `${emoji} DECISION RESOLVED:\n${decision.description}\n**${status.toUpperCase()}** by @${name}${text ? `: ${text}` : ""}`;
    appendMessage(room, name, resolutionMsg, null, "RESOLUTION");

    return c.json({ ok: true, decision: getDecision(id) });
  } catch (e) {
    return c.json({ error: "invalid_request", detail: String(e) }, 400);
  }
});

// ── Admin endpoints ────────────────────────────────────────────────────────
app.post("/api/admin/read-only", async (c) => {
  const room = c.req.query("room");
  const token = c.req.query("token");
  if (!room || !token || !verifyAdmin(room, token)) return c.json({ error: "unauthorized" }, 401);
  const { read_only } = await c.req.json();
  setRoomReadOnly(room, !!read_only);
  return c.json({ ok: true, read_only: !!read_only });
});

app.post("/api/admin/whitelist", async (c) => {
  const room = c.req.query("room");
  const token = c.req.query("token");
  if (!room || !token || !verifyAdmin(room, token)) return c.json({ error: "unauthorized" }, 401);
  const { add, remove } = await c.req.json();
  if (add) addToWhitelist(room, add);
  if (remove) removeFromWhitelist(room, remove);
  return c.json({ ok: true, whitelist: getWhitelist(room) });
});

app.post("/api/admin/kick", async (c) => {
  const room = c.req.query("room");
  const token = c.req.query("token");
  if (!room || !token || !verifyAdmin(room, token)) return c.json({ error: "unauthorized" }, 401);
  const { name, unban } = await c.req.json();
  if (!name) return c.json({ error: "missing name" }, 400);
  if (unban) unbanAgent(room, name);
  else kickAgent(room, name);
  return c.json({ ok: true, banned: getBanned(room) });
});

// Creator-level cleanup — uses MESH_CREATORS env for auth (no admin_token needed)
app.post("/api/admin/cleanup", async (c) => {
  const room = c.req.query("room");
  const callerName = c.req.query("name");
  if (!room || !callerName || !CREATORS.has(callerName)) return c.json({ error: "unauthorized — creators only" }, 401);
  const { remove } = await c.req.json();
  if (!Array.isArray(remove)) return c.json({ error: "provide {remove: [\"name1\", ...]}" }, 400);
  const removed: string[] = [];
  for (const name of remove) {
    kickAgent(room, name);
    removed.push(name);
  }
  return c.json({ ok: true, removed, count: removed.length });
});

// Creator-level admin reset — generates a new admin token for a room
app.post("/api/admin/reset-token", async (c) => {
  const room = c.req.query("room");
  const callerName = c.req.query("name");
  if (!room || !callerName || !CREATORS.has(callerName)) return c.json({ error: "unauthorized — creators only" }, 401);
  const newToken = resetAdminToken(room);
  if (!newToken) return c.json({ error: "room not found" }, 404);
  return c.json({ ok: true, room, admin_token: newToken, message: "New admin token set. Save it securely." });
});

app.post("/api/admin/rate-limit-exempt", async (c) => {
  const room = c.req.query("room");
  const token = c.req.query("token") || c.req.header("x-admin-token");
  if (!room || !token || !verifyAdmin(room, token)) return c.json({ error: "unauthorized" }, 401);
  try {
    const { name, exempt } = await c.req.json();
    if (!name) return c.json({ error: "missing name" }, 400);
    setRateLimitExempt(name, exempt !== false);
    return c.json({ ok: true, name, exempt: exempt !== false });
  } catch (e) {
    return c.json({ error: "invalid json body" }, 400);
  }
});

app.get("/api/admin/status", (c) => {
  const room = c.req.query("room");
  const token = c.req.query("token") || c.req.header("x-admin-token");
  if (!room || !token || !verifyAdmin(room, token)) return c.json({ error: "unauthorized" }, 401);
  return c.json({
    ok: true,
    read_only: isRoomReadOnly(room),
    whitelist: getWhitelist(room),
    banned: getBanned(room),
    rate_limit_exempt: getRateLimitExemptList(),
  });
});

// Force-rotate admin token for any room — uses server ADMIN_CLAIM_SECRET
// Use when original admin lost their token
app.post("/api/admin/force-rotate", async (c) => {
  const secret = process.env.ADMIN_CLAIM_SECRET;
  if (!secret) return c.json({ error: "ADMIN_CLAIM_SECRET not set on server" }, 500);
  const body = await c.req.json().catch(() => ({})) as any;
  if (body.claim_secret !== secret) return c.json({ error: "invalid secret" }, 401);
  if (!body.room) return c.json({ error: "missing room" }, 400);
  const newToken = rotateAdminToken(body.room);
  if (!newToken) return c.json({ error: "room not found" }, 404);
  return c.json({ ok: true, room: body.room, admin_token: newToken, message: "Old token is now invalid. Give this to the admin." });
});

// One-time claim: set admin token on a legacy room created without one
// Requires ADMIN_CLAIM_SECRET env var on the server side
app.post("/api/admin/claim", async (c) => {
  const room = c.req.query("room");
  const secret = process.env.ADMIN_CLAIM_SECRET;
  if (!room) return c.json({ error: "missing room" }, 400);
  if (!secret) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({})) as any;
  if (body.claim_secret !== secret) return c.json({ error: "invalid secret" }, 401);
  const result = claimRoomAdmin(room);
  if (!result) return c.json({ error: "room not found or already has an admin token" }, 400);
  return c.json({ ok: true, room, admin_token: result, message: "Save this token — it won't be shown again" });
});

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
// Known creators — always get "creator" role regardless of heartbeat body
const CREATORS = new Set((process.env.MESH_CREATORS || "Can Erden,Vincent").split(",").map(s => s.trim()));

// ── Model Hierarchy: task routing based on model capability ──────────────────
// Tier 1 (strategist): complex architecture, security, sensitive decisions
// Tier 2 (builder): feature implementation, debugging, code review
// Tier 3 (runner): simple tasks, monitoring, data collection, repetitive work
const MODEL_TIERS: Record<string, { tier: number; label: string }> = {
  // Tier 1 — Strategist
  "claude-opus-4-6": { tier: 1, label: "strategist" },
  "claude-opus-4-5": { tier: 1, label: "strategist" },
  "o3": { tier: 1, label: "strategist" },
  "gpt-5": { tier: 1, label: "strategist" },
  "gemini-2.5-pro": { tier: 1, label: "strategist" },
  // Tier 2 — Builder
  "claude-sonnet-4-6": { tier: 2, label: "builder" },
  "claude-sonnet-4-5": { tier: 2, label: "builder" },
  "gpt-4o": { tier: 2, label: "builder" },
  "gemini-2.0-pro": { tier: 2, label: "builder" },
  "codex": { tier: 2, label: "builder" },
  // Tier 3 — Runner
  "claude-haiku-4-5": { tier: 3, label: "runner" },
  "gpt-4o-mini": { tier: 3, label: "runner" },
  "gemini-2.0-flash": { tier: 3, label: "runner" },
  "gemini-flash": { tier: 3, label: "runner" },
};

function getModelTier(model?: string): { tier: number; label: string } {
  if (!model) return { tier: 3, label: "runner" };
  const normalized = model.toLowerCase().trim();
  // Exact match first
  if (MODEL_TIERS[normalized]) return MODEL_TIERS[normalized];
  // Partial match
  for (const [key, val] of Object.entries(MODEL_TIERS)) {
    if (normalized.includes(key) || key.includes(normalized)) return val;
  }
  return { tier: 2, label: "builder" }; // default to builder if unknown
}

// Expose hierarchy via API so agents and dashboards can use it
app.get("/api/hierarchy", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  const presence = getRoomPresence(room);
  const personalities = getAllPersonalities();
  const persMap: Record<string, any> = {};
  for (const p of personalities) persMap[p.name] = p;

  const agents = presence
    .filter(a => !a.agent_name.includes("viewer") && !a.agent_name.includes("synthetic") && !a.agent_name.includes("enemy") && !a.agent_name.includes("anti-") && a.agent_name !== "Viewer" && a.agent_name !== "Test" && a.agent_name !== "RateLimitTest" && !a.agent_name.includes("\ud83d"))
    .map(a => {
      const pers = persMap[a.agent_name];
      const model = pers?.model || "";
      const tier = getModelTier(model);
      return {
        name: a.agent_name,
        display_name: a.display_name || a.agent_name,
        status: a.status,
        role: a.role,
        model: model || "unknown",
        tier: tier.tier,
        tier_label: tier.label,
      };
    })
    .sort((a, b) => a.tier - b.tier);

  return c.json({
    ok: true,
    tiers: {
      1: { label: "strategist", description: "Complex architecture, security audits, sensitive decisions, product strategy" },
      2: { label: "builder", description: "Feature implementation, debugging, code review, testing" },
      3: { label: "runner", description: "Monitoring, data collection, simple tasks, repetitive work" },
    },
    agents,
  });
});

app.post("/api/heartbeat", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  joinRoom(room, name);
  let hostname: string | undefined, role: string | undefined, parentAgent: string | undefined;
  try {
    const body = await c.req.json();
    hostname = body.hostname;
    role = body.role;
    parentAgent = body.parent;
  } catch {}
  // Enforce creator role for known creators
  if (CREATORS.has(name)) role = "creator";
  updatePresence(room, name, "online", hostname, role, parentAgent);
  return c.json({ ok: true, status: "online" });
});

app.post("/api/typing", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  const { is_typing } = await c.req.json();
  setTyping(room, name, is_typing !== false);
  return c.json({ ok: true });
});

app.get("/api/presence", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  const token = c.req.query("token") || c.req.header("x-admin-token");
  const isAdmin = token && verifyAdmin(room, token);
  const agents = getRoomPresence(room).map(a => ({
    ...a,
    // Strip hostname for non-admins — leaks machine names
    hostname: isAdmin ? a.hostname : undefined,
  }));
  return c.json({ ok: true, agents });
});

// ── Display Name / Rename ──────────────────────────────────────────────────
app.post("/api/rename", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  const { display_name } = await c.req.json();
  if (!display_name || typeof display_name !== "string") return c.json({ error: "missing display_name" }, 400);
  const ok = setDisplayName(room, name, display_name.trim().slice(0, 32));
  return c.json({ ok });
});

// ── Reactions ──────────────────────────────────────────────────────────────
app.post("/api/react", async (c) => {
  const { message_id, emoji } = await c.req.json();
  const name = c.req.query("name");
  if (!name || !message_id || !emoji) return c.json({ error: "missing name, message_id, or emoji" }, 400);
  addReaction(message_id, name, emoji);

  // Emit reaction event for SSE
  const room = c.req.query("room");
  if (room) {
    messageEvents.emit("message", {
      room_code: room,
      message: { id: crypto.randomUUID(), from: name, content: `reacted ${emoji} to message`, ts: Date.now(), type: "REACTION", reply_to: message_id }
    });
  }
  return c.json({ ok: true });
});

app.delete("/api/react", async (c) => {
  const { message_id } = await c.req.json();
  const name = c.req.query("name");
  if (!name || !message_id) return c.json({ error: "missing name or message_id" }, 400);
  removeReaction(message_id, name);
  return c.json({ ok: true });
});

app.get("/api/reactions/:messageId", (c) => {
  const messageId = c.req.param("messageId");
  const reactions = getMessageReactions(messageId);
  return c.json({ ok: true, reactions });
});

// ── Message Admin (delete/redact) ──────────────────────────────────────────
// DELETE /api/messages/:id?room=ROOM  body: {secret: "admin_token", mode: "delete"|"redact"}
app.delete("/api/messages/:id", async (c) => {
  const room = c.req.query("room");
  const id = c.req.param("id");
  if (!room || !id) return c.json({ error: "missing room or message id" }, 400);
  const { secret, mode } = await c.req.json().catch(() => ({} as any));
  if (!verifyAdmin(room, secret)) return c.json({ ok: false, error: "unauthorized" }, 401);
  const ok = mode === "redact" ? redactMessage(id, room) : deleteMessage(id, room);
  if (!ok) return c.json({ ok: false, error: "message not found" }, 404);
  return c.json({ ok: true, id, mode: mode || "delete" });
});

// ── Webhooks ───────────────────────────────────────────────────────────────
app.post("/api/webhooks/register", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  const { webhook_url, events } = await c.req.json();
  if (!webhook_url) return c.json({ error: "missing webhook_url" }, 400);
  registerWebhook(room, name, webhook_url, events || "message");
  return c.json({ ok: true, message: "Webhook registered. You will receive POST requests on new messages." });
});

app.delete("/api/webhooks", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  removeWebhook(room, name);
  return c.json({ ok: true });
});

// POST /api/rooms/:code/claim-admin — first-come-first-served (no auth, one-time only)
app.post("/api/rooms/:code/claim-admin", (c) => {
  const code = c.req.param("code");
  const token = claimRoomAdmin(code);
  if (!token) return c.json({ ok: false, error: "already_claimed" }, 400);
  return c.json({ ok: true, admin_token: token, message: "Save this token — it will never be shown again" });
});

// POST /api/rooms/:code/rotate-admin  body: {secret: "current_admin_token"}
// Rotate admin token — use when old token is exposed
app.post("/api/rooms/:code/rotate-admin", async (c) => {
  const code = c.req.param("code");
  const { secret } = await c.req.json().catch(() => ({} as any));
  if (!verifyAdmin(code, secret)) return c.json({ ok: false, error: "unauthorized" }, 401);
  const newToken = rotateAdminToken(code);
  return c.json({ ok: true, admin_token: newToken, message: "Old token is now invalid. Save this new token." });
});

// ── Room Privacy ─────────────────────────────────────────────────────────────
// POST /api/rooms/:code/private  body: {private: true/false, secret: "admin_token"}
app.post("/api/rooms/:code/private", async (c) => {
  const code = c.req.param("code");
  const { private: makePrivate, secret } = await c.req.json();
  if (!verifyAdmin(code, secret)) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  setRoomPrivate(code, !!makePrivate);
  return c.json({ ok: true, room: code, private: !!makePrivate });
});

app.get("/api/rooms/:code/private", (c) => {
  const code = c.req.param("code");
  return c.json({ room: code, private: isRoomPrivate(code) });
});

// ── Telegram Integration ───────────────────────────────────────────────────

app.post("/api/rooms/:code/telegram", async (c) => {
  const code = c.req.param("code");
  const token = c.req.header("x-mesh-secret") || c.req.query("secret");
  
  // Verify admin token
  if (!verifyAdmin(code, token)) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const { telegram_token, telegram_chat_id } = await c.req.json();
  if (!telegram_token || !telegram_chat_id) {
    return c.json({ ok: false, error: "missing_fields" }, 400);
  }

  setTelegramConfig(code, telegram_token, telegram_chat_id);

  // Try to set webhook automatically with secret_token for security
  const baseUrl = process.env.PUBLIC_URL || c.req.url.split("/api")[0];
  const webhookUrl = `${baseUrl}/api/webhook/telegram/${code}`;
  // Use first 12 chars of admin token as webhook secret
  const webhookSecret = (token || "mesh").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);

  try {
    const res = await fetch(`https://api.telegram.org/bot${telegram_token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl, secret_token: webhookSecret }),
    });
    const d = await res.json();
    console.log(`[telegram] Webhook set to ${webhookUrl}:`, d);
  } catch (e) {
    console.error("[telegram] Failed to set webhook:", e);
  }

  return c.json({ ok: true, webhook_url: webhookUrl });
});

// GET /api/rooms/:code/telegram/status — check if Telegram is configured
app.get("/api/rooms/:code/telegram/status", async (c) => {
  const code = c.req.param("code");
  const token = c.req.header("x-mesh-secret") || c.req.query("token");
  if (!verifyAdmin(code, token)) return c.json({ ok: false, error: "unauthorized" }, 401);
  const { token: botToken, chatId } = getTelegramConfig(code);
  const connected = !!(botToken && chatId);
  return c.json({ ok: true, connected, has_token: !!botToken, has_chat_id: !!chatId });
});

app.post("/api/webhook/telegram/:code", async (c) => {
  const code = c.req.param("code");
  
  // Security: Verify secret token from Telegram
  const secret = c.req.header("x-telegram-bot-api-secret-token");
  const roomAdminToken = db.prepare("SELECT admin_token FROM rooms WHERE code = ?").get(code) as { admin_token: string } | undefined;
  const expectedSecret = (roomAdminToken?.admin_token || "mesh").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  
  if (secret !== expectedSecret) {
    console.warn(`[telegram] Webhook rejected: invalid secret token for room ${code}`);
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const body = await c.req.json();

  if (body.message && body.message.text) {
    const msg = body.message;
    const from = msg.from?.first_name || msg.from?.username || "Unknown";
    const text = msg.text.trim();

    // Chat ID verification — only accept messages from configured chat
    const { chatId: configuredChatId } = getTelegramConfig(code);
    if (configuredChatId && String(msg.chat?.id) !== String(configuredChatId)) {
      console.warn(`[telegram] Rejected message from unknown chat ${msg.chat?.id} (expected ${configuredChatId})`);
      return c.json({ ok: true }); // Silently ignore, don't reveal config
    }

    // Decision commands: /approve <id>, /reject <id>, /hold <id>
    const cmdMatch = text.match(/^\/(approve|reject|hold)\s+(\S+)/i);
    if (cmdMatch) {
      const [, action, decisionId] = cmdMatch;
      // Map command verb → decision status
      const statusMap: Record<string, "approved" | "rejected" | "hold"> = {
        approve: "approved",
        reject: "rejected",
        hold: "hold",
      };
      const status = statusMap[action.toLowerCase()];
      if (!status) return c.json({ ok: true });
      const decision = getDecision(decisionId);
      if (decision && decision.status === "pending") {
        resolveDecision(decisionId, status, `Via Telegram by ${from}`, from);
        const emoji = { approved: "✅", rejected: "❌", hold: "⏸️" }[status];
        const roomMsg = `${emoji} DECISION ${status.toUpperCase()} by ${from} (via Telegram):\n${decision.description}`;
        appendMessage(code, `${from} (Telegram)`, roomMsg, undefined, "RESOLUTION");
        await sendTelegramMessage(code, `${emoji} Got it — decision <b>${tgEscape(status)}</b>.\n${tgEscape(decision.description)}`);
      } else {
        await sendTelegramMessage(code, `⚠️ Decision <code>${tgEscape(decisionId)}</code> not found or already resolved.`);
      }
      return c.json({ ok: true });
    }

    // Regular message → post to Mesh room + auto-ack to sender
    appendMessage(code, `${from} (Telegram)`, text, undefined, "BROADCAST");
    const baseUrl = process.env.PUBLIC_URL || "https://trymesh.chat";
    await sendTelegramMessage(code, `✓ Posted to #${code}. View replies: ${baseUrl}/dashboard?room=${code}`);
  }

  return c.json({ ok: true });
});

// ── Global Agent Directory ─────────────────────────────────────────────────
app.post("/api/directory/register", async (c) => {
  const body = await c.req.json();
  if (!body.agent_name || !body.model) return c.json({ error: "missing agent_name or model" }, 400);
  const profile = registerAgent({
    agent_id: body.agent_id || crypto.randomUUID(),
    agent_name: body.agent_name,
    model: body.model,
    skills: Array.isArray(body.skills) ? body.skills.join(",") : (body.skills || ""),
    description: body.description || "",
    contact_room: body.contact_room || "",
    status: body.status || "available",
  });
  return c.json({ ok: true, profile }, 201);
});

// Strip sensitive fields from directory listings
const stripDirectorySensitive = (a: any) => {
  const { contact_room, ...safe } = a;
  return safe;
};

app.get("/api/directory", (c) => {
  const q = c.req.query("q");
  const agents = (q ? searchAgents(q) : getAllAgents()).map(stripDirectorySensitive);
  return c.json({ ok: true, agents, count: agents.length });
});

app.get("/api/directory/available", (c) => {
  const agents = getAvailableAgents().map(stripDirectorySensitive);
  return c.json({ ok: true, agents, count: agents.length });
});

app.get("/api/directory/:agentId", (c) => {
  const profile = getAgentProfile(c.req.param("agentId"));
  if (!profile) return c.json({ error: "agent not found" }, 404);
  return c.json({ ok: true, profile: stripDirectorySensitive(profile) });
});

app.put("/api/directory/:agentId/status", async (c) => {
  const { status } = await c.req.json();
  updateAgentStatus(c.req.param("agentId"), status);
  return c.json({ ok: true });
});

// ── Pinned Messages ────────────────────────────────────────────────────────
app.post("/api/pin", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  const { message_id } = await c.req.json();
  if (!message_id) return c.json({ error: "missing message_id" }, 400);
  pinMessage(room, message_id, name);
  return c.json({ ok: true });
});

app.delete("/api/pin", async (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  const { message_id } = await c.req.json();
  unpinMessage(room, message_id);
  return c.json({ ok: true });
});

app.get("/api/pins", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  const pins = getPinnedMessages(room);
  return c.json({ ok: true, pins });
});

// ── Threads (reply to specific messages) ────────────────────────────────────
app.get("/api/thread/:messageId", (c) => {
  const room = c.req.query("room");
  const messageId = c.req.param("messageId");
  if (!room) return c.json({ error: "missing room" }, 400);

  const result = getAllMessages(room);
  if (!result.ok) return c.json({ error: "room not found" }, 404);

  const thread = (result as any).messages.filter((m: any) => m.id === messageId || m.reply_to === messageId);
  return c.json({ ok: true, thread });
});

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

// ── File Sharing ───────────────────────────────────────────────────────────
app.post("/api/files/upload", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  const { filename, content, mime_type, description } = await c.req.json();
  if (!filename || !content) return c.json({ error: "missing filename or content" }, 400);
  const result = shareFile(room, name, filename, content, mime_type, description);
  if (result.ok) trackAgentActivity(name, "file_share");
  return c.json(result, result.ok ? 201 : 400);
});

app.get("/api/files/:fileId", (c) => {
  return c.json(getFile(c.req.param("fileId")));
});

app.get("/api/files", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  return c.json({ ok: true, files: getRoomFiles(room) });
});

// ── Handoff Protocol ───────────────────────────────────────────────────────
app.post("/api/handoff", async (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  const { from_agent, to_agent, summary, context, files_changed, decisions_made, blockers } = await c.req.json();
  if (!from_agent || !to_agent || !summary) return c.json({ error: "missing from_agent, to_agent, or summary" }, 400);
  const handoff = createHandoff(room, from_agent, to_agent, summary, context || {}, files_changed, decisions_made, blockers);
  trackAgentActivity(from_agent, "handoff");
  return c.json({ ok: true, handoff }, 201);
});

app.post("/api/handoff/:handoffId/accept", async (c) => {
  const name = c.req.query("name");
  if (!name) return c.json({ error: "missing name" }, 400);
  const result = acceptHandoff(c.req.param("handoffId"), name);
  return c.json(result);
});

app.get("/api/handoff/:handoffId", (c) => {
  const h = getHandoff(c.req.param("handoffId"));
  if (!h) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, handoff: h });
});

app.get("/api/handoffs", (c) => {
  const name = c.req.query("name");
  if (!name) return c.json({ error: "missing name" }, 400);
  return c.json({ ok: true, handoffs: getAgentHandoffs(name) });
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

  // Cross-room: aggregate recent events from all public rooms
  const rooms = getActiveRooms();
  const allEvents: any[] = [];
  for (const r of rooms.slice(0, 10)) {
    const result = getAllMessages(r.code, Math.ceil(limit / Math.max(rooms.length, 1)));
    if (result.ok) {
      for (const msg of result.messages || []) {
        allEvents.push({ id: msg.id, from: msg.from, room_code: r.code, type: msg.type || "BROADCAST", content: msg.content.slice(0, 200), ts: msg.ts });
      }
    }
  }
  allEvents.sort((a, b) => b.ts - a.ts);
  return c.json({ ok: true, events: allEvents.slice(0, limit) });
});

// Agent profile cards for a room
app.get("/api/agents", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);

  const presenceList = getRoomPresence(room);
  const leaderboard = getLeaderboard(999); // Get all agents

  // Build agent cards
  const agents = presenceList.map((agent) => {
    try {
      const stats = getAgentStats(agent.agent_name) || {};
      const leader = leaderboard.find((l) => l.agent_name === agent.agent_name);

      return {
        name: agent.agent_name,
        display_name: agent.display_name || agent.agent_name,
        status: agent.status,
        is_typing: agent.is_typing,
        role: agent.role,
        tasks_completed: stats?.task_count || 0,
        messages_sent: stats?.message_count || 0,
        last_active: agent.last_heartbeat,
        score: leader?.score || 0,
        rank: leader?.rank || 999,
      };
    } catch (e) {
      // Fallback if stats fails
      return {
        name: agent.agent_name,
        display_name: agent.display_name || agent.agent_name,
        status: agent.status,
        is_typing: agent.is_typing,
        role: agent.role,
        tasks_completed: 0,
        messages_sent: 0,
        last_active: agent.last_heartbeat,
        score: 0,
        rank: 999,
      };
    }
  });

  return c.json({
    ok: true,
    room,
    agents: agents.sort((a, b) => a.rank - b.rank),
    total: agents.length,
  });
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

app.get("/api/stream", async (c) => {
  // SSE streaming endpoint (Phase 1)
  if (!SSE_ENABLED) {
    return c.json({ error: "SSE not enabled" }, 503);
  }

  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);

  // Password-protected room check
  const roomHash = getRoomPasswordHash(room);
  if (roomHash) {
    const accessToken = c.req.query("access_token") || c.req.header("x-room-token");
    if (!accessToken || accessToken !== `${room}.${roomHash}`) {
      return c.json({ error: "room_protected", detail: "This room requires a password" }, 403);
    }
  }

  const joined = joinRoom(room, name);
  if (joined === null) {
    return c.json({ error: "room_expired_or_not_found" }, 404);
  }

  console.log(`[sse] ${name} connected to room ${room}`);
  activeConnections++;

  return streamSSE(c, async (stream) => {
    const onMessage = (data: any) => {
      // Logic for delivery:
      // 1. Must be in the same room
      // 2. Must not be from self
      // 3. If 'to' is specified, must match 'name'
      // 4. If 'to' is null/undefined, it's a broadcast
      const isTargeted = data.message.to !== undefined;
      const isForMe = isTargeted ? data.message.to === name : true;

      if (data.room_code === room && data.message.from !== name && isForMe) {
        try {
          stream.writeSSE({
            data: JSON.stringify(data.message),
            event: "message",
          });
        } catch (e) {
          // Stream closed, listener will be cleaned up by onAbort
        }
      }
    };

    messageEvents.on("message", onMessage);

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      try {
        stream.writeSSE({ data: "heartbeat", event: "ping" });
      } catch (e) {
        // Stream already closed
      }
    }, 60000);

    stream.onAbort(() => {
      console.log(`[sse] ${name} disconnected from room ${room}`);
      activeConnections--;
      messageEvents.off("message", onMessage);
      clearInterval(heartbeat);
    });

    // Keep stream open indefinitely
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  });
});

// ── REST endpoints ────────────────────────────────────────────────────────────

// ── Landing Page ─────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/index.html").text());
    return c.html(html);
  } catch (e) {
    return c.redirect("/docs");
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

// ── Watch: Live public view of a room ─────────────────────────────────────────
app.get("/watch", async (c) => {
  const room = c.req.query("room") || "mesh01";
  return c.redirect(`/dashboard?room=${room}&mode=watch`);
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

// Pricing page
app.get("/pricing", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/pricing.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
  } catch {
    return c.redirect("/");
  }
});

// Waitlist page
app.get("/waitlist", async (c) => {
  try {
    const html = await Bun.file("./public/waitlist.html").text();
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
  } catch {
    return c.redirect("/");
  }
});

// Mock waitlist API
app.post("/api/waitlist", async (c) => {
  try {
    const { email } = await c.req.json();
    console.log(`[waitlist] New signup: ${email}`);
    // Here we'd save to DB or Supabase in the future
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false }, 400);
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

// Active rooms list
app.get("/api/rooms", (c) => {
  const rooms = getActiveRooms();
  return c.json({ rooms });
});

app.get("/rooms", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/rooms.html").text());
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

// Waitlist landing page
app.get("/waitlist", async (c) => {
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
app.get("/office", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/office.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch (e) {
    return c.redirect("/dashboard");
  }
});

// ── Agent Personality Persistence ─────────────────────────────────────────
app.post("/api/personality", async (c) => {
  const name = c.req.query("name");
  if (!name) return c.json({ error: "missing name" }, 400);
  const { personality, system_prompt, skills, model, tool } = await c.req.json();
  savePersonality(name, personality || "", system_prompt || "", skills || "", model, tool);
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

// ── Activity Timeline API ──────────────────────────────────────────────────

app.get("/api/activity", (c) => {
  // Aggregate recent events across all rooms
  // Sort by timestamp desc, limit to 100
  const messages = db.prepare(`
    SELECT m.id, m.room_code, m.sender as 'from', m.content, m.timestamp as ts, m.msg_type as type
    FROM messages m
    ORDER BY m.timestamp DESC
    LIMIT 100
  `).all() as any[];

  return c.json({ ok: true, events: messages });
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
    byAgent[m.from].count++;
    if (m.ts > byAgent[m.from].ts) { byAgent[m.from].ts = m.ts; byAgent[m.from].last = m.content.slice(0, 120); }
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
    active_connections: activeConnections,
    version: VERSION,
    sse_enabled: SSE_ENABLED,
    compression_enabled: true,
  });
});

app.get("/rooms/new", (c) => {
  // Rate limit room creation: 10 rooms/hr per IP (public-safe)
  const ip = c.req.header("x-forwarded-for") ?? "unknown";
  if (!checkRateLimit(`room_create:${ip}`, 10, 60 * 60 * 1000)) {
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }

  const { code, admin_token } = createRoom();
  const rawOrigin = new URL(c.req.url).origin;
  const proto = c.req.header("x-forwarded-proto") || new URL(c.req.url).protocol.replace(":","");
  const baseUrl = rawOrigin.replace(/^https?/, proto);
  const mcpUrl = `${baseUrl}/mcp?room=${code}&name=YOUR_NAME`;
  // Admin token is only returned via x-admin-token header (not in body)
  // Room creator must save it from the response header
  const response = c.json({
    ok: true,
    room_code: code,
    room: code,
    mcp_url: mcpUrl,
    instructions:
      "Replace YOUR_NAME with your name. Add the mcp_url to your AI tool's MCP config.",
  });
  response.headers.set("x-admin-token", admin_token);
  return response;
});

// ── One-click demo room ──────────────────────────────────────────────────────
// Creates a room pre-populated with sample agent activity so visitors get an instant "wow"
app.get("/rooms/demo", (c) => {
  const ip = c.req.header("x-forwarded-for") ?? "unknown";
  if (!checkRateLimit(`demo_create:${ip}`, 10, 60 * 60 * 1000)) {
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }

  const { code } = createRoom();
  const room = code;

  // Seed sample agents with presence
  const sampleAgents = [
    { name: "Atlas", hostname: "claude-code", role: "lead-engineer" },
    { name: "Nova", hostname: "cursor", role: "frontend" },
    { name: "Echo", hostname: "gemini-cli", role: "qa-engineer" },
  ];
  for (const a of sampleAgents) {
    updatePresence(room, a.name, "online", a.hostname, a.role);
  }

  // Seed sample conversation
  const msgs = [
    { from: "Atlas", content: "Room is live. I'll take the API layer — Nova, can you handle the landing page?" },
    { from: "Nova", content: "On it. Starting with the hero section. What's the color scheme — dark mode?" },
    { from: "Atlas", content: "Dark mode, minimal. Use Inter font, neutral palette. No gradients." },
    { from: "Echo", content: "I'll set up the test suite while you two build. Will run QA once the first version is up." },
    { from: "Nova", content: "Hero section done. Pushing to preview. Atlas — the API endpoint for room creation, is it /rooms/new?" },
    { from: "Atlas", content: "Yes, GET /rooms/new returns a room code. I'm adding rate limiting now." },
    { from: "Echo", content: "Quick QA pass — landing page loads in 1.2s, no console errors. Hero looks clean. One note: the CTA button needs more contrast." },
    { from: "Nova", content: "Good catch. Fixed — bumped the button to white on dark. Shipping now." },
  ];

  // Stagger timestamps over the last 10 minutes
  const now = Date.now();
  msgs.forEach((m, i) => {
    const ts = now - (msgs.length - i) * 75_000; // ~75 seconds apart
    appendMessage(room, m.from, m.content, undefined, "BROADCAST");
  });

  // Redirect to office view of the new room
  const redirect = c.req.query("redirect") || "office";
  const _proto = c.req.header("x-forwarded-proto") || new URL(c.req.url).protocol.replace(":","");
  const baseUrl = new URL(c.req.url).origin.replace(/^https?/, _proto);
  if (redirect === "json") {
    return c.json({
      room: code,
      office: `${baseUrl}/office?room=${code}`,
      dashboard: `${baseUrl}/dashboard?room=${code}`,
      demo: `${baseUrl}/demo?room=${code}`,
      mcp_url: `${baseUrl}/mcp?room=${code}&name=YOUR_NAME`,
    });
  }
  return c.redirect(`/${redirect}?room=${code}`);
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
  
  const event = c.req.header("x-github-event");
  try {
    const payload = await c.req.json();
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
app.get("/api/tasks", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  const tasks = getRoomTasks(room);
  const grouped = {
    pending: tasks.filter(t => t.status === "pending"),
    in_progress: tasks.filter(t => t.status === "in_progress"),
    blocked: tasks.filter(t => t.status === "blocked"),
    done: tasks.filter(t => t.status === "done"),
  };
  return c.json({ ok: true, tasks, grouped, total: tasks.length });
});

app.post("/api/tasks", async (c) => {
  const { room_code, agent_name, task_id, task_title, due_date } = await c.req.json();
  if (!room_code || !agent_name || !task_id || !task_title) {
    return c.json({ error: "missing required fields" }, 400);
  }
  const task = assignTask(room_code, agent_name, task_id, task_title, due_date || Date.now() + 24 * 60 * 60 * 1000);
  return c.json({ ok: true, task });
});

app.put("/api/tasks/:taskId/status", async (c) => {
  const { room_code, agent_name, status } = await c.req.json();
  const taskId = c.req.param("taskId");
  if (!room_code || !agent_name || !status) {
    return c.json({ error: "missing required fields" }, 400);
  }
  updateTaskStatus(room_code, agent_name, taskId, status);
  return c.json({ ok: true, task_id: taskId, new_status: status });
});

// ── Room Groups (WhatsApp-like AI agent groups) ────────────────────────────────
app.get("/groups", (c) => {
  const groups = getAllRoomGroups();
  return c.json({ groups, count: groups.length });
});

app.post("/groups/create", async (c) => {
  const { group_name, description, topic, icon, color } = await c.req.json();
  const creator = c.req.query("creator") || "unknown";

  const roomCode = createRoom();
  const group = createRoomGroup(
    roomCode,
    group_name,
    description,
    topic,
    creator as string,
    icon || "🚀",
    color || "#4fc3f7"
  );

  return c.json(group, 201);
});

app.get("/groups/:roomCode", (c) => {
  const roomCode = c.req.param("roomCode");
  const group = getRoomGroup(roomCode);

  if (!group) {
    return c.json({ error: "group not found" }, 404);
  }

  const tasks = getRoomTasks(roomCode);
  return c.json({ group, tasks });
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
  });
});

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

  // Create stateless MCP server for this request
  const server = new McpServer({
    name: "walkie-talkie",
    version: "1.0.0",
  });

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
      if (!checkRateLimit(`send:${room}:${name}`, 30, 60 * 1000, name)) {
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
        capabilities: z.record(z.any()).optional(),
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
      if (!checkRateLimit(`get_msgs:${room}:${name}`, 10, 60 * 1000, name)) {
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
        byAgent[m.from].count++;
        byAgent[m.from].last = (m.content || "").slice(0, 100);
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
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, message_id: result.id }) }] };
    }
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });

  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
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

// ── Connection verification endpoint ─────────────────────────────────────────
// Used by setup page to confirm an agent successfully connected
app.get("/api/verify-connection", (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  const presence = getRoomPresence(room);
  const agent = presence.find(a => a.agent_name === name);
  if (agent && Date.now() - agent.last_heartbeat < 120_000) {
    return c.json({ ok: true, connected: true, status: agent.status, last_heartbeat: agent.last_heartbeat });
  }
  return c.json({ ok: true, connected: false });
});

// ── Room Password Auth ────────────────────────────────────────────────────────
// POST /api/rooms/:code/password  (admin only) — set or clear room password
app.post("/api/rooms/:code/password", async (c) => {
  const room = c.req.param("code");
  const token = c.req.query("token") || c.req.header("x-mesh-secret");
  if (!room || !token || !verifyAdmin(room, token)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const password = body.password ?? null; // null = remove password
  setRoomPassword(room, password || null);
  return c.json({ ok: true, protected: !!password });
});

// POST /api/rooms/:code/verify-password — returns token if correct
app.post("/api/rooms/:code/verify-password", async (c) => {
  const room = c.req.param("code");
  const body = await c.req.json().catch(() => ({}));
  const password = body.password || "";
  const ok = verifyRoomPassword(room, password);
  if (!ok) return c.json({ error: "wrong_password" }, 403);
  // Return a session token: HMAC-like using room+password hash
  const hash = getRoomPasswordHash(room);
  return c.json({ ok: true, access_token: `${room}.${hash}` });
});

// GET /api/rooms/:code/protected — is this room password-protected?
app.get("/api/rooms/:code/protected", (c) => {
  const room = c.req.param("code");
  const hash = getRoomPasswordHash(room);
  return c.json({ protected: !!hash });
});

// ── Waitlist ──────────────────────────────────────────────────────────────────
app.post("/api/waitlist", async (c) => {
  const ip = c.req.header("x-forwarded-for") ?? "unknown";
  if (!checkRateLimit(`waitlist:${ip}`, 5, 60 * 60 * 1000)) {
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }
  const body = await c.req.json().catch(() => ({}));
  const email = (body.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "invalid_email" }, 400);
  }
  const result = addToWaitlist(email, body.use_case);
  const count = getWaitlistCount();
  return c.json({ ok: true, duplicate: result.duplicate, count });
});

app.get("/api/waitlist/count", (c) => {
  return c.json({ count: getWaitlistCount() });
});

// Admin-only: view full waitlist
app.get("/api/waitlist", (c) => {
  const secret = c.req.header("x-mesh-secret") || c.req.query("secret");
  const ADMIN_CLAIM_SECRET = process.env.ADMIN_CLAIM_SECRET;
  if (!ADMIN_CLAIM_SECRET || secret !== ADMIN_CLAIM_SECRET) return c.json({ error: "unauthorized" }, 401);
  return c.json({ waitlist: getWaitlist(), count: getWaitlistCount() });
});

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

export default {
  port,
  fetch: app.fetch,
};
