import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  createRoom, joinRoom, appendMessage, getMessages, getRoomStatus,
  getAllMessages, getRoomCount, getActiveAgentsCount, getMessagesPerMinute,
  getTotalMessagesSent, getAvgLatencyMs, trackMetric, updatePresence,
  setTyping, getRoomPresence, addReaction, removeReaction, getMessageReactions,
  publishCard, getPartnerCards, setDisplayName, getDisplayName,
  deleteMessage, redactMessage, verifyAdmin, registerWebhook, removeWebhook,
  searchMessages, scheduleMessage, getScheduledMessages, cancelScheduledMessage,
  shareFile, getFile, getRoomFiles, createHandoff, acceptHandoff, getHandoff,
  getAgentHandoffs, getTemplates, getTemplate, createRoomFromTemplate, createDemoRoom,
  getLeaderboard, getAgentStats, getProductivityReport, trackAgentActivity,
  messageEvents, ensureRoom, isRoomReadOnly, canAgentSend, getActiveRooms,
  getRoomPasswordHash, getGrowthMetrics, getAllPersonalities, pinMessage, unpinMessage,
  getPinnedMessages,
} from "../rooms.js";
import { getRoomTasks, getAllAgentTasks } from "../room-manager.js";
import { checkRateLimit, isDuplicateMessage, CREATORS } from "../middleware.js";

const api = new Hono();

export const VERSION = "3.0.0";
export const startTime = Date.now();
export let activeConnections = 0;

// ── Feature flags ──────────────────────────────────────────────────────────
const SSE_ENABLED = process.env.SSE_DISABLED !== "true";
if (SSE_ENABLED) console.log("[init] SSE streaming enabled (default)");

// ── Model Hierarchy ────────────────────────────────────────────────────────
const MODEL_TIERS: Record<string, { tier: number; label: string }> = {
  "claude-opus-4-6": { tier: 1, label: "strategist" },
  "claude-opus-4-5": { tier: 1, label: "strategist" },
  "o3": { tier: 1, label: "strategist" },
  "gpt-5": { tier: 1, label: "strategist" },
  "gemini-2.5-pro": { tier: 1, label: "strategist" },
  "claude-sonnet-4-6": { tier: 2, label: "builder" },
  "claude-sonnet-4-5": { tier: 2, label: "builder" },
  "gpt-4o": { tier: 2, label: "builder" },
  "gemini-2.0-pro": { tier: 2, label: "builder" },
  "codex": { tier: 2, label: "builder" },
  "claude-haiku-4-5": { tier: 3, label: "runner" },
  "gpt-4o-mini": { tier: 3, label: "runner" },
  "gemini-2.0-flash": { tier: 3, label: "runner" },
  "gemini-flash": { tier: 3, label: "runner" },
};

function getModelTier(model?: string): { tier: number; label: string } {
  if (!model) return { tier: 3, label: "runner" };
  const normalized = model.toLowerCase().trim();
  if (MODEL_TIERS[normalized]) return MODEL_TIERS[normalized];
  for (const [key, val] of Object.entries(MODEL_TIERS)) {
    if (normalized.includes(key) || key.includes(normalized)) return val;
  }
  return { tier: 2, label: "builder" };
}

// ── Core API routes ────────────────────────────────────────────────────────

api.get("/api/status", (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  joinRoom(room, name);
  return c.json(getRoomStatus(room, name));
});

api.post("/api/join", (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  joinRoom(room, name);
  updatePresence(room, name, "online");
  return c.json({ ok: true, room_code: room, agent_name: name });
});

api.get("/api/messages", (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  const msgType = c.req.query("type");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  joinRoom(room, name);
  const isViewer = name.endsWith('-viewer') || name.startsWith('Viewer');
  const msgLimit = isViewer ? 120 : 30;
  if (!checkRateLimit(`get_msgs:${room}:${name}`, msgLimit, 60 * 1000, name)) {
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }
  return c.json(getMessages(room, name, msgType));
});

api.get("/api/history", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  const hash = getRoomPasswordHash(room);
  if (hash) {
    const accessToken = c.req.query("access_token") || c.req.header("x-room-token");
    if (!accessToken || accessToken !== `${room}.${hash}`) {
      return c.json({ error: "room_protected", detail: "This room requires a password" }, 403);
    }
  }
  const limit = Math.min(parseInt(c.req.query("limit") || "100"), 500);
  const since = c.req.query("since") ? parseInt(c.req.query("since")!) : undefined;
  const viewer = c.req.query("viewer") || c.req.query("name") || undefined;
  return c.json(getAllMessages(room, limit, since, viewer));
});

api.get("/api/metrics", (c) => {
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

api.get("/api/metrics/growth", (c) => {
  return c.json({ ok: true, ...getGrowthMetrics() });
});

api.get("/api/version", (c) => {
  return c.json({
    version: VERSION,
    build_date: new Date(startTime).toISOString(),
    sse_enabled: SSE_ENABLED,
    compression: "gzip/brotli",
  });
});

api.post("/api/send", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  ensureRoom(room);
  joinRoom(room, name);
  updatePresence(room, name, "online");

  if (!checkRateLimit(`send:${room}:${name}`, 30, 60 * 1000, name)) {
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }
  const sendIp = c.req.header("x-forwarded-for") ?? "unknown";
  if (!checkRateLimit(`send_ip:${sendIp}`, 100, 60 * 1000)) {
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }

  if (isRoomReadOnly(room)) return c.json({ error: "room_read_only", detail: "This room is read-only" }, 403);
  if (!canAgentSend(room, name)) return c.json({ error: "not_allowed", detail: "You are not allowed to send in this room" }, 403);

  try {
    const { message, to, type, reply_to } = await c.req.json();
    const reqStart = Date.now();
    const displayName = getDisplayName(room, name);
    const rawType = (type || "BROADCAST").toUpperCase();
    const safeType = (rawType === "DECISION" || rawType === "RESOLUTION") ? "BROADCAST" : rawType;
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

// ── Presence & Typing ──────────────────────────────────────────────────────

api.get("/api/hierarchy", (c) => {
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

api.post("/api/heartbeat", async (c) => {
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
  if (CREATORS.has(name)) role = "creator";
  updatePresence(room, name, "online", hostname, role, parentAgent);
  return c.json({ ok: true, status: "online" });
});

api.post("/api/typing", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  const { is_typing } = await c.req.json();
  setTyping(room, name, is_typing !== false);
  return c.json({ ok: true });
});

api.get("/api/presence", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  const token = c.req.query("token") || c.req.header("x-admin-token");
  const isAdmin = token && verifyAdmin(room, token);
  const agents = getRoomPresence(room).map(a => ({
    ...a,
    hostname: isAdmin ? a.hostname : undefined,
  }));
  return c.json({ ok: true, agents });
});

api.post("/api/rename", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  const { display_name } = await c.req.json();
  if (!display_name || typeof display_name !== "string") return c.json({ error: "missing display_name" }, 400);
  return c.json({ ok: setDisplayName(room, name, display_name.trim().slice(0, 32)) });
});

// ── Reactions ──────────────────────────────────────────────────────────────

api.post("/api/react", async (c) => {
  const { message_id, emoji } = await c.req.json();
  const name = c.req.query("name");
  if (!name || !message_id || !emoji) return c.json({ error: "missing name, message_id, or emoji" }, 400);
  addReaction(message_id, name, emoji);
  const room = c.req.query("room");
  if (room) {
    messageEvents.emit("message", {
      room_code: room,
      message: { id: crypto.randomUUID(), from: name, content: `reacted ${emoji} to message`, ts: Date.now(), type: "REACTION", reply_to: message_id }
    });
  }
  return c.json({ ok: true });
});

api.delete("/api/react", async (c) => {
  const { message_id } = await c.req.json();
  const name = c.req.query("name");
  if (!name || !message_id) return c.json({ error: "missing name or message_id" }, 400);
  removeReaction(message_id, name);
  return c.json({ ok: true });
});

api.get("/api/reactions/:messageId", (c) => {
  return c.json({ ok: true, reactions: getMessageReactions(c.req.param("messageId")) });
});

// ── Message Admin ──────────────────────────────────────────────────────────

api.delete("/api/messages/:id", async (c) => {
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

api.post("/api/webhooks/register", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  const { webhook_url, events } = await c.req.json();
  if (!webhook_url) return c.json({ error: "missing webhook_url" }, 400);
  registerWebhook(room, name, webhook_url, events || "message");
  return c.json({ ok: true, message: "Webhook registered. You will receive POST requests on new messages." });
});

api.delete("/api/webhooks", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  removeWebhook(room, name);
  return c.json({ ok: true });
});

// ── Cards ──────────────────────────────────────────────────────────────────

api.post("/api/publish", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  joinRoom(room, name);
  const { card } = await c.req.json();
  return c.json(publishCard(room, name, card));
});

api.get("/api/cards", (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  joinRoom(room, name);
  return c.json(getPartnerCards(room, name));
});

// ── Pins ───────────────────────────────────────────────────────────────────

api.post("/api/pin", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  const { message_id } = await c.req.json();
  if (!message_id) return c.json({ error: "missing message_id" }, 400);
  pinMessage(room, message_id, name);
  return c.json({ ok: true });
});

api.delete("/api/pin", async (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  const { message_id } = await c.req.json();
  unpinMessage(room, message_id);
  return c.json({ ok: true });
});

api.get("/api/pins", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  return c.json({ ok: true, pins: getPinnedMessages(room) });
});

// ── Threads ────────────────────────────────────────────────────────────────

api.get("/api/thread/:messageId", (c) => {
  const room = c.req.query("room");
  const messageId = c.req.param("messageId");
  if (!room) return c.json({ error: "missing room" }, 400);
  const result = getAllMessages(room);
  if (!result.ok) return c.json({ error: "room not found" }, 404);
  const thread = (result as any).messages.filter((m: any) => m.id === messageId || m.reply_to === messageId);
  return c.json({ ok: true, thread });
});

// ── Search ─────────────────────────────────────────────────────────────────

api.get("/api/search", (c) => {
  const room = c.req.query("room");
  const q = c.req.query("q");
  if (!room || !q) return c.json({ error: "missing room or q" }, 400);
  const limit = parseInt(c.req.query("limit") || "50");
  const results = searchMessages(room, q, limit);
  return c.json({ ok: true, results, count: results.length, query: q });
});

// ── Scheduled Messages ─────────────────────────────────────────────────────

api.post("/api/schedule", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  const { message, send_at, to, type } = await c.req.json();
  if (!message || !send_at) return c.json({ error: "missing message or send_at (unix ms)" }, 400);
  const id = scheduleMessage(room, name, message, send_at, to, type || "BROADCAST");
  return c.json({ ok: true, schedule_id: id, sends_at: new Date(send_at).toISOString() }, 201);
});

api.get("/api/schedule", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  return c.json({ ok: true, scheduled: getScheduledMessages(room) });
});

api.delete("/api/schedule/:scheduleId", (c) => {
  return c.json({ ok: cancelScheduledMessage(c.req.param("scheduleId")) });
});

// ── Files ──────────────────────────────────────────────────────────────────

api.post("/api/files/upload", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  const { filename, content, mime_type, description } = await c.req.json();
  if (!filename || !content) return c.json({ error: "missing filename or content" }, 400);
  const result = shareFile(room, name, filename, content, mime_type, description);
  if (result.ok) trackAgentActivity(name, "file_share");
  return c.json(result, result.ok ? 201 : 400);
});

api.get("/api/files/:fileId", (c) => {
  return c.json(getFile(c.req.param("fileId")));
});

api.get("/api/files", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  return c.json({ ok: true, files: getRoomFiles(room) });
});

// ── Handoffs ───────────────────────────────────────────────────────────────

api.post("/api/handoff", async (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  const { from_agent, to_agent, summary, context, files_changed, decisions_made, blockers } = await c.req.json();
  if (!from_agent || !to_agent || !summary) return c.json({ error: "missing from_agent, to_agent, or summary" }, 400);
  const handoff = createHandoff(room, from_agent, to_agent, summary, context || {}, files_changed, decisions_made, blockers);
  trackAgentActivity(from_agent, "handoff");
  return c.json({ ok: true, handoff }, 201);
});

api.post("/api/handoff/:handoffId/accept", async (c) => {
  const name = c.req.query("name");
  if (!name) return c.json({ error: "missing name" }, 400);
  return c.json(acceptHandoff(c.req.param("handoffId"), name));
});

api.get("/api/handoff/:handoffId", (c) => {
  const h = getHandoff(c.req.param("handoffId"));
  if (!h) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, handoff: h });
});

api.get("/api/handoffs", (c) => {
  const name = c.req.query("name");
  if (!name) return c.json({ error: "missing name" }, 400);
  return c.json({ ok: true, handoffs: getAgentHandoffs(name) });
});

// ── Templates ──────────────────────────────────────────────────────────────

api.get("/api/templates", (c) => {
  return c.json({ ok: true, templates: getTemplates() });
});

api.get("/api/templates/:templateId", (c) => {
  const t = getTemplate(c.req.param("templateId"));
  if (!t) return c.json({ error: "template not found" }, 404);
  return c.json({ ok: true, template: t });
});

api.post("/api/templates/:templateId/create-room", async (c) => {
  const name = c.req.query("name") || "anonymous";
  const result = createRoomFromTemplate(c.req.param("templateId"), name);
  return c.json(result, result.ok ? 201 : 400);
});

api.get("/api/demo", (c) => {
  return c.json(createDemoRoom(), createDemoRoom().ok ? 200 : 400);
});

// ── Leaderboard & Stats ────────────────────────────────────────────────────

api.get("/api/leaderboard", (c) => {
  const limit = parseInt(c.req.query("limit") || "20");
  return c.json({ ok: true, leaderboard: getLeaderboard(limit) });
});

api.get("/api/activity", (c) => {
  const room = c.req.query("room");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);

  if (room) {
    const messagesResult = getAllMessages(room, limit);
    const presence = getRoomPresence(room);
    if (!messagesResult.ok) return c.json({ error: messagesResult.error }, 404);
    const events = (messagesResult.messages || []).map((msg) => ({
      id: msg.id, from: msg.from, room_code: room, type: msg.type || "BROADCAST",
      content: msg.content.slice(0, 200), ts: msg.ts,
    }));
    return c.json({ ok: true, room, events, agents_online: presence.filter((a) => a.status === "online").length });
  }

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

api.get("/api/agents", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  const presenceList = getRoomPresence(room);
  const leaderboard = getLeaderboard(999);
  const agents = presenceList.map((agent) => {
    try {
      const stats = getAgentStats(agent.agent_name) || {};
      const leader = leaderboard.find((l) => l.agent_name === agent.agent_name);
      return {
        name: agent.agent_name, display_name: agent.display_name || agent.agent_name,
        status: agent.status, is_typing: agent.is_typing, role: agent.role,
        tasks_completed: stats?.task_count || 0, messages_sent: stats?.message_count || 0,
        last_active: agent.last_heartbeat, score: leader?.score || 0, rank: leader?.rank || 999,
      };
    } catch {
      return {
        name: agent.agent_name, display_name: agent.display_name || agent.agent_name,
        status: agent.status, is_typing: agent.is_typing, role: agent.role,
        tasks_completed: 0, messages_sent: 0, last_active: agent.last_heartbeat, score: 0, rank: 999,
      };
    }
  });
  return c.json({ ok: true, room, agents: agents.sort((a, b) => a.rank - b.rank), total: agents.length });
});

api.get("/api/stats/:agentName", (c) => {
  const stats = getAgentStats(c.req.param("agentName"));
  if (!stats) return c.json({ error: "agent not found" }, 404);
  return c.json({ ok: true, stats });
});

api.get("/api/productivity/:agentName", (c) => {
  const report = getProductivityReport(c.req.param("agentName"));
  if (!report) return c.json({ error: "agent not found" }, 404);
  return c.json({ ok: true, report });
});

api.post("/api/productivity/log", async (c) => {
  const name = c.req.query("name");
  if (!name) return c.json({ error: "missing name" }, 400);
  const { activity, value } = await c.req.json();
  const validActivities = ["task_complete","commit","bug_fix","review","lines_of_code","file_share","handoff"];
  if (!validActivities.includes(activity)) return c.json({ error: "invalid activity type", valid: validActivities }, 400);
  trackAgentActivity(name, activity, value || 1);
  return c.json({ ok: true, logged: activity, value: value || 1 });
});

// ── Rooms ──────────────────────────────────────────────────────────────────

api.get("/api/rooms", (c) => {
  return c.json({ rooms: getActiveRooms() });
});

// ── SSE Stream ─────────────────────────────────────────────────────────────

api.get("/api/stream", async (c) => {
  if (!SSE_ENABLED) return c.json({ error: "SSE not enabled" }, 503);

  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);

  const roomHash = getRoomPasswordHash(room);
  if (roomHash) {
    const accessToken = c.req.query("access_token") || c.req.header("x-room-token");
    if (!accessToken || accessToken !== `${room}.${roomHash}`) {
      return c.json({ error: "room_protected", detail: "This room requires a password" }, 403);
    }
  }

  const joined = joinRoom(room, name);
  if (joined === null) return c.json({ error: "room_expired_or_not_found" }, 404);

  console.log(`[sse] ${name} connected to room ${room}`);
  activeConnections++;

  return streamSSE(c, async (stream) => {
    const onMessage = (data: any) => {
      const isTargeted = data.message.to !== undefined;
      const isForMe = isTargeted ? data.message.to === name : true;
      if (data.room_code === room && data.message.from !== name && isForMe) {
        try {
          stream.writeSSE({ data: JSON.stringify(data.message), event: "message" });
        } catch {}
      }
    };

    messageEvents.on("message", onMessage);

    const heartbeat = setInterval(() => {
      try { stream.writeSSE({ data: "heartbeat", event: "ping" }); } catch {}
    }, 60000);

    stream.onAbort(() => {
      console.log(`[sse] ${name} disconnected from room ${room}`);
      activeConnections--;
      messageEvents.off("message", onMessage);
      clearInterval(heartbeat);
    });

    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  });
});

// ── Briefing ───────────────────────────────────────────────────────────────

api.get("/api/briefing", (c) => {
  const room = c.req.query("room");
  const since = parseInt(c.req.query("since") || "0") || Date.now() - 8 * 60 * 60 * 1000;
  if (!room) return c.json({ error: "missing room" }, 400);

  const result = getAllMessages(room, 200, since);
  const recent = (result as any).messages || [];
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
    ``, `Activity: ${recent.length} messages from ${Object.keys(byAgent).length} agents`,
    ...Object.entries(byAgent).sort((a,b) => b[1].count - a[1].count).map(([name, d]) =>
      `  ${name} (${d.count} msgs) — last: "${d.last.slice(0,80)}"`),
    ``, `Tasks completed: ${doneSince.length}`,
    ...doneSince.map((t: any) => `  ✓ ${t.title} (${t.agent_name})`),
    ``, `Tasks in progress: ${inProgress.length}`,
    ...inProgress.map((t: any) => `  → ${t.title} (${t.agent_name})`),
  ];

  return c.json({
    ok: true, since: new Date(since).toISOString(), messages: recent.length,
    agents_active: Object.keys(byAgent).length, tasks_done: doneSince.length,
    tasks_in_progress: inProgress.length, briefing: lines.join("\n"),
    by_agent: Object.fromEntries(Object.entries(byAgent).map(([name, d]: [string, any]) => [name, { count: d.count }])),
  });
});

// ── Health ─────────────────────────────────────────────────────────────────

api.get("/health", (c) => {
  return c.json({
    status: "ok", uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    room_count: getRoomCount(), active_connections: activeConnections,
    version: VERSION, sse_enabled: SSE_ENABLED, compression_enabled: true,
  });
});

// ── Verify Connection ──────────────────────────────────────────────────────

api.get("/api/verify-connection", (c) => {
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

export default api;
