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
  savePersonality,
  getPersonality,
  getAllPersonalities,
  generateIdentityBlock,
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
} from "./room-manager.js";

const app = new Hono();
const startTime = Date.now();
const VERSION = "2.0.0-mesh";

// Track active SSE connections
let activeConnections = 0;

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
function checkRateLimit(key: string, max: number, windowMs: number): boolean {
  return checkRateLimitPersistent(key, max, windowMs);
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

app.get("/api/messages", (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  const msgType = c.req.query("type");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  joinRoom(room, name);
  if (!checkRateLimit(`get_msgs:${room}:${name}`, 10, 60 * 1000)) {
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }
  const result = getMessages(room, name, msgType);
  return c.json(result);
});

app.get("/api/history", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  const result = getAllMessages(room);
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
  joinRoom(room, name);

  // Rate limit sends: 30 messages/min per agent
  if (!checkRateLimit(`send:${room}:${name}`, 30, 60 * 1000)) {
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
    const result = appendMessage(room, displayName, message, to, type || "BROADCAST", reply_to);
    trackMetric("api_request", room!, name!, Date.now() - reqStart);
    trackAgentActivity(name!, "message");
    return c.json(result);
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

app.get("/api/admin/status", (c) => {
  const room = c.req.query("room");
  const token = c.req.query("token");
  if (!room || !token || !verifyAdmin(room, token)) return c.json({ error: "unauthorized" }, 401);
  return c.json({
    ok: true,
    read_only: isRoomReadOnly(room),
    whitelist: getWhitelist(room),
    banned: getBanned(room),
  });
});

// One-time claim: set admin token on a legacy room created without one
// Requires ADMIN_CLAIM_SECRET env var on the server side
app.post("/api/admin/claim", async (c) => {
  const room = c.req.query("room");
  const secret = process.env.ADMIN_CLAIM_SECRET;
  if (!room) return c.json({ error: "missing room" }, 400);
  if (!secret) return c.json({ error: "ADMIN_CLAIM_SECRET not configured on server" }, 503);
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
  const agents = getRoomPresence(room);
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

app.get("/api/directory", (c) => {
  const q = c.req.query("q");
  const agents = q ? searchAgents(q) : getAllAgents();
  return c.json({ ok: true, agents, count: agents.length });
});

app.get("/api/directory/available", (c) => {
  const agents = getAvailableAgents();
  return c.json({ ok: true, agents, count: agents.length });
});

app.get("/api/directory/:agentId", (c) => {
  const profile = getAgentProfile(c.req.param("agentId"));
  if (!profile) return c.json({ error: "agent not found" }, 404);
  return c.json({ ok: true, profile });
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

// ── Leaderboard & Stats ────────────────────────────────────────────────────
app.get("/api/leaderboard", (c) => {
  const limit = parseInt(c.req.query("limit") || "20");
  return c.json({ ok: true, leaderboard: getLeaderboard(limit) });
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
    }, 30000);

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
    const html = await Bun.file("./public/index.html").text();
    return c.html(html);
  } catch (e) {
    return c.redirect("/docs");
  }
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

// ── Watch: Live public view of a room ─────────────────────────────────────────
app.get("/watch", async (c) => {
  const room = c.req.query("room") || "mesh01";
  return c.redirect(`/dashboard?room=${room}&mode=watch`);
});

// Public demo — watch live agent collaboration
app.get("/demo", async (c) => {
  try {
    const html = await Bun.file("./public/demo.html").text();
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store" },
    });
  } catch (e) {
    return c.redirect("/dashboard?room=mesh01&mode=watch");
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
  if (name) {
    const p = getPersonality(name);
    return p ? c.json({ ok: true, ...p }) : c.json({ error: "not found" }, 404);
  }
  return c.json({ ok: true, agents: getAllPersonalities() });
});

app.get("/api/personality/identity-block", (c) => {
  const name = c.req.query("name");
  if (!name) return c.json({ error: "missing name" }, 400);
  const block = generateIdentityBlock(name);
  return new Response(block, { headers: { "Content-Type": "text/plain" } });
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
  // Rate limit room creation: 100 rooms/hr per IP
  const ip = c.req.header("x-forwarded-for") ?? "unknown";
  if (!checkRateLimit(`room_create:${ip}`, 100, 60 * 60 * 1000)) {
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }

  const { code, admin_token } = createRoom();
  const baseUrl = new URL(c.req.url).origin;
  return c.json({
    room: code,
    admin_token,
    claude_code_url: `${baseUrl}/mcp?room=${code}&name=YOUR_NAME`,
    antigravity_url: `${baseUrl}/mcp?room=${code}&name=YOUR_NAME`,
    instructions:
      "Replace YOUR_NAME with your name. Add the URL to your AI tool's MCP config.",
  });
});

// ── Admin endpoints (require admin_token) ────────────────────────────────────
app.post("/api/admin/read-only", async (c) => {
  const room = c.req.query("room");
  const token = c.req.query("token") || c.req.header("x-admin-token");
  if (!room || !token) return c.json({ error: "missing room or token" }, 400);
  if (!verifyAdmin(room, token)) return c.json({ error: "unauthorized" }, 403);
  const { read_only } = await c.req.json();
  setRoomReadOnly(room, read_only !== false);
  return c.json({ ok: true, read_only: read_only !== false });
});

app.get("/api/admin/verify", (c) => {
  const room = c.req.query("room");
  const token = c.req.query("token") || c.req.header("x-admin-token");
  if (!room || !token) return c.json({ error: "missing room or token" }, 400);
  return c.json({ ok: true, is_admin: verifyAdmin(room, token) });
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
    const html = await Bun.file("./public/api-docs.html").text();
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

  // Auto-join room on first contact (creates user state / cursor)
  const joined = joinRoom(room, name);
  if (joined === null) {
    return c.json({ error: "room_expired_server_restarted" }, 404);
  }

  // Create stateless MCP server for this request
  const server = new McpServer({
    name: "walkie-talkie",
    version: "1.0.0",
  });

  // Tool: send_to_partner
  server.tool(
    "send_to_partner",
    "Send a message to your partner's AI. They will receive it on their next get_partner_messages() call.",
    {
      message: z.string().describe("The message to send to your partner's AI"),
      to: z.string().optional().describe("Optional: specific recipient name for private/targeted messaging"),
      type: z.string().optional().describe("Optional: message type (BROADCAST, TASK, HANDOFF, DIRECT, SYSTEM)")
    },
    async ({ message, to, type }) => {
      // Rate limit sends: 30 messages/min per agent
      if (!checkRateLimit(`send:${room}:${name}`, 30, 60 * 1000)) {
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
      if (!checkRateLimit(`get_msgs:${room}:${name}`, 10, 60 * 1000)) {
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

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

export default {
  port,
  fetch: app.fetch,
};
