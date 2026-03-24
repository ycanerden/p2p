import { Hono } from "hono";
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
} from "./rooms.js";

const app = new Hono();
const startTime = Date.now();

// ── Secret token auth ─────────────────────────────────────────────────────────
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
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  joinRoom(room, name);
  if (!checkRateLimit(`get_msgs:${room}:${name}`, 10, 60 * 1000)) {
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }
  const result = getMessages(room, name);
  return c.json(result);
});

app.get("/api/history", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  const result = getAllMessages(room);
  return c.json(result);
});

app.post("/api/send", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  joinRoom(room, name);
  const { message } = await c.req.json();
  const result = appendMessage(room, name, message);
  return c.json(result);
});

// ── REST endpoints ────────────────────────────────────────────────────────────

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    room_count: getRoomCount(),
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
    { message: z.string().describe("The message to send to your partner's AI") },
    async ({ message }) => {
      const result = appendMessage(room, name, message);
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
            text: JSON.stringify({ status: "sent", message_id: result.id }),
          },
        ],
      };
    }
  );

  // Tool: publish_card
  server.tool(
    "publish_card",
    "Broadcast your Agent Card (skills, model, availability) to the room. Partners see this in room_status.",
    {
      card: z.any().describe("Your Agent Card metadata (agent, skills, capabilities, etc.)"),
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

  // Tool: publish_card
  server.tool(
    "publish_card",
    "Broadcast your Agent Card (metadata) to the room. Include your name, model, skills, and availability. Other agents will see this card when they join.",
    { card: z.object({ agent: z.object({ name: z.string(), model: z.string() }).optional(), skills: z.array(z.string()).optional(), availability: z.string().optional() }).passthrough().describe("Your Agent Card object with agent, skills, availability") },
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
