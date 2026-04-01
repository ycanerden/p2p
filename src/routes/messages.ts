import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  joinRoom,
  getMessages,
  appendMessage,
  deleteMessage,
  redactMessage,
  registerWebhook,
  removeWebhook,
  messageEvents,
  getAllMessages,
  roomExists,
  getRoomPasswordHash,
  updatePresence,
  ensureRoom,
  getDisplayName,
  canAgentSend,
  trackMetric,
  trackAgentActivity,
  verifyAdmin
} from "../rooms.js";
import { getRoomTasks } from "../room-manager.js";
import {
  checkRateLimit,
  hasRoomAccess,
  isDuplicateMessage,
  SSE_ENABLED,
  activeConnections
} from "./utils.js";

export function registerMessagesRoutes(app: Hono) {
  app.get("/api/messages", (c) => {
    const room = c.req.query("room");
    const name = c.req.query("name");
    const msgType = c.req.query("type");
    if (!room || !name) return c.json({ error: "missing room or name" }, 400);
    joinRoom(room, name);
    // Viewers (demo-viewer, office-viewer, web viewers) get generous limits
    const isViewer = name.endsWith("-viewer") || name.startsWith("Viewer");
    const msgLimit = isViewer ? 1000 : 1000;
    if (!checkRateLimit(`get_msgs:${room}:${name}`, msgLimit, 60 * 1000, name)) {
      return c.json({ error: "rate_limit_exceeded" }, 429);
    }
    const result = getMessages(room, name, msgType);
    return c.json(result);
  });

  app.post("/api/send", async (c) => {
    const room = c.req.query("room");
    const name = c.req.query("name");
    if (!room || !name) return c.json({ error: "missing room or name" }, 400);
    ensureRoom(room);
    joinRoom(room, name);
    // Sending a message = proof of life — update presence so agent shows in office
    updatePresence(room, name, "online");

    // Rate limit sends: 1000 messages/min per agent, 1000/min per IP globally
    if (!checkRateLimit(`send:${room}:${name}`, 1000, 60 * 1000, name)) {
      return c.json({ error: "rate_limit_exceeded" }, 429);
    }
    const sendIp = c.req.header("x-forwarded-for") ?? "unknown";
    if (!checkRateLimit(`send_ip:${sendIp}`, 1000, 60 * 1000)) {
      return c.json({ error: "rate_limit_exceeded" }, 429);
    }

    // Extract agent token for identity verification
    const authHeader = c.req.header("Authorization") || "";
    const agentToken =
      authHeader.replace(/^Bearer /, "").trim() ||
      c.req.header("x-agent-token") ||
      c.req.query("token") ||
      "";

    if (!canAgentSend(room, name, agentToken)) {
      return c.json(
        {
          error: "not_allowed",
          detail: agentToken
            ? "Invalid agent token"
            : "Agent token required for this name in this room",
        },
        403
      );
    }

    try {
      const { message, to, type, reply_to } = await c.req.json();
      const reqStart = Date.now();
      // Use display_name if set so senders appear with their chosen name
      const displayName = getDisplayName(room, name);
      // Sanitize type: block DECISION/RESOLUTION from /api/send (only /api/decisions creates those)
      const rawType = (type || "BROADCAST").toUpperCase();
      const safeType =
        rawType === "DECISION" || rawType === "RESOLUTION"
          ? "BROADCAST"
          : rawType;
      // Block loop spam: reject if agent sends identical message 3+ times within 60s
      if (isDuplicateMessage(room, displayName, message)) {
        return c.json(
          {
            error: "duplicate_message",
            detail:
              "Identical message sent too many times recently — possible agent loop",
          },
          429
        );
      }
      const result = appendMessage(
        room,
        displayName,
        message,
        to,
        safeType,
        reply_to
      );
      trackMetric("api_request", room!, name!, Date.now() - reqStart);
      trackAgentActivity(name!, "message");
      return c.json(result);
    } catch (e) {
      return c.json({ error: "invalid_request", detail: String(e) }, 400);
    }
  });

  // ── Message Admin (delete/redact) ──────────────────────────────────────────
  // DELETE /api/messages/:id?room=ROOM  body: {secret: "admin_token", mode: "delete"|"redact"}
  app.delete("/api/messages/:id", async (c) => {
    const room = c.req.query("room");
    const id = c.req.param("id");
    if (!room || !id)
      return c.json({ error: "missing room or message id" }, 400);
    const { secret, mode } = await c.req.json().catch(() => ({} as any));
    if (!verifyAdmin(room, secret))
      return c.json({ ok: false, error: "unauthorized" }, 401);
    const ok =
      mode === "redact" ? redactMessage(id, room) : deleteMessage(id, room);
    if (!ok) return c.json({ ok: false, error: "message not found" }, 404);
    return c.json({ ok: true, id, mode: mode || "delete" });
  });

  // ── Webhooks ───────────────────────────────────────────────────────────────
  app.post("/api/webhooks/register", async (c) => {
    const room = c.req.query("room");
    const name = c.req.query("name");
    const token = c.req.query("token") || c.req.header("x-admin-token");
    if (!room || !name) return c.json({ error: "missing room or name" }, 400);
    if (!verifyAdmin(room, token))
      return c.json({ error: "unauthorized" }, 401);

    const { webhook_url, events, secret } = await c.req.json();
    if (!webhook_url) return c.json({ error: "missing webhook_url" }, 400);
    registerWebhook(room, name, webhook_url, events || "message", secret);
    return c.json({
      ok: true,
      message:
        "Webhook registered. You will receive POST requests on new messages.",
    });
  });

  app.delete("/api/webhooks", async (c) => {
    const room = c.req.query("room");
    const name = c.req.query("name");
    if (!room || !name) return c.json({ error: "missing room or name" }, 400);
    removeWebhook(room, name);
    return c.json({ ok: true });
  });

  app.get("/api/stream", async (c) => {
    // SSE streaming endpoint (Phase 1)
    if (!SSE_ENABLED) {
      return c.json({ error: "SSE not enabled" }, 503);
    }

    const room = c.req.query("room");
    const name = c.req.query("name");
    const observer = c.req.query("observer") === "1";
    if (!room || !name) return c.json({ error: "missing room or name" }, 400);

    // Password-protected room check
    if (!hasRoomAccess(c, room)) {
      return c.json(
        { error: "room_protected", detail: "This room requires a password" },
        403
      );
    }

    if (observer) {
      if (!roomExists(room))
        return c.json({ error: "room_expired_or_not_found" }, 404);
    } else {
      const joined = joinRoom(room, name);
      if (joined === null) {
        return c.json({ error: "room_expired_or_not_found" }, 404);
      }
    }

    console.log(
      `[sse] ${name} connected to room ${room}${observer ? " (observer)" : ""}`
    );
    activeConnections.count++;

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
        activeConnections.count--;
        messageEvents.off("message", onMessage);
        clearInterval(heartbeat);
      });

      // Keep stream open indefinitely
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    });
  });

  // ── Digest (S3 fallback) ─────────────────────────────────────────────────────
  app.get("/api/digest", (c) => {
    const room = c.req.query("room");
    if (!room) return c.json({ error: "missing room" }, 400);

    const roomHash = getRoomPasswordHash(room);
    if (roomHash) {
      const accessToken =
        c.req.query("access_token") || c.req.header("x-room-token");
      if (!accessToken || accessToken !== `${room}.${roomHash}`) {
        return c.json(
          { error: "room_protected", detail: "This room requires a password" },
          403
        );
      }
    }

    if (!roomExists(room))
      return c.json({ error: "room_expired_or_not_found" }, 404);

    const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);
    const since = c.req.query("since")
      ? parseInt(c.req.query("since")!)
      : undefined;
    const viewer = c.req.query("viewer") || c.req.query("name") || undefined;

    const result = getAllMessages(room, limit, since, viewer);
    if (!(result as any).ok) {
      return c.json(
        { error: (result as any).error || "messages_not_found" },
        404
      );
    }

    const messages = (result as any).messages || [];
    const byAgent: Record<
      string,
      { count: number; last: string; last_ts: number }
    > = {};
    for (const m of messages) {
      if (!m.from) continue;
      if (!byAgent[m.from]) byAgent[m.from] = { count: 0, last: "", last_ts: 0 };
      const agentData = byAgent[m.from]!;
      agentData.count += 1;
      if (m.ts > agentData.last_ts) {
        agentData.last_ts = m.ts;
        agentData.last = (m.content || "").slice(0, 160);
      }
    }

    const tasks = getRoomTasks(room);
    const inProgress = tasks.filter((t: any) => t.status === "in_progress");
    const pending = tasks.filter((t: any) => t.status === "pending");
    const done = tasks.filter((t: any) => t.status === "done");

    return c.json({
      ok: true,
      room,
      since: since || null,
      total_messages: messages.length,
      agents: Object.entries(byAgent)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([name, data]) => ({
          name,
          count: data.count,
          last: data.last,
          last_ts: data.last_ts,
        })),
      tasks: {
        in_progress: inProgress,
        pending,
        done,
      },
      sample: messages.slice(-10),
    });
  });
}
