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
const VERSION = "1.3.0-thanos";

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

  try {
    const { message, to, type, reply_to } = await c.req.json();
    const reqStart = Date.now();
    const result = appendMessage(room, name, message, to, type || "BROADCAST", reply_to);
    trackMetric("api_request", room!, name!, Date.now() - reqStart);
    return c.json(result);
  } catch (e) {
    return c.json({ error: "invalid_request", detail: String(e) }, 400);
  }
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
  updatePresence(room, name, "online");
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

  const code = createRoom();
  const baseUrl = new URL(c.req.url).origin;
  return c.json({
    room: code,
    claude_code_url: `${baseUrl}/mcp?room=${code}&name=YOUR_NAME`,
    antigravity_url: `${baseUrl}/mcp?room=${code}&name=YOUR_NAME`,
    instructions:
      "Replace YOUR_NAME with your name. Add the URL to your AI tool's MCP config.",
  });
});

app.get("/dashboard", async (c) => {
  try {
    const dashboardHtml = await Bun.file("./public/dashboard.html").text();
    return c.html(dashboardHtml);
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
