import type { Hono } from "hono";
import {
  joinRoom,
  appendMessage,
  updatePresence,
  setTyping,
  getRoomPresence,
  verifyAdmin,
} from "../rooms.js";
import { CREATORS } from "./admin.js";

// System agents that should not trigger join notifications
const SYSTEM_AGENT_NAMES = new Set(["system"]);

export function registerPresenceRoutes(app: Hono) {
  // ── Heartbeat / Presence ────────────────────────────────────────────────

  app.post("/api/heartbeat", async (c) => {
    const room = c.req.query("room");
    const name = c.req.query("name");
    if (!room || !name) return c.json({ error: "missing room or name" }, 400);
    joinRoom(room, name);
    let hostname: string | undefined,
      role: string | undefined,
      parentAgent: string | undefined;
    try {
      const body = await c.req.json();
      hostname = body.hostname;
      role = body.role;
      parentAgent = body.parent;
    } catch {}
    // Enforce creator role for known creators
    if (CREATORS.has(name)) role = "creator";

    // Emit join notification when a real agent comes online from offline
    const isSystemAgent =
      name.endsWith("-viewer") ||
      name.startsWith("Viewer") ||
      SYSTEM_AGENT_NAMES.has(name) ||
      name.includes("synthetic") ||
      name.includes("anti-");
    if (!isSystemAgent) {
      const existing = getRoomPresence(room).find((a) => a.agent_name === name);
      const wasOffline =
        !existing || existing.last_heartbeat < Date.now() - 300_000;
      if (wasOffline) {
        appendMessage(room, "system", `→ ${name} joined`, undefined, "SYSTEM");
      }
    }

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
    const agents = getRoomPresence(room).map((a) => ({
      ...a,
      hostname: isAdmin ? a.hostname : undefined,
    }));
    return c.json({ ok: true, agents });
  });

  // Agent profile cards for a room (simplified — no stats/leaderboard)
  app.get("/api/agents", (c) => {
    const room = c.req.query("room");
    if (!room) return c.json({ error: "missing room" }, 400);

    const presenceList = getRoomPresence(room);
    const agents = presenceList.map((agent) => ({
      name: agent.agent_name,
      display_name: agent.display_name || agent.agent_name,
      status: agent.status,
      is_typing: agent.is_typing,
      role: agent.role,
      last_active: agent.last_heartbeat,
    }));

    return c.json({
      ok: true,
      room,
      agents,
      total: agents.length,
    });
  });
}
