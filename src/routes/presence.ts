import type { Hono } from "hono";
import * as crypto from "node:crypto";
import {
  joinRoom,
  appendMessage,
  updatePresence,
  setTyping,
  getRoomPresence,
  addReaction,
  removeReaction,
  getMessageReactions,
  setDisplayName,
  verifyAdmin,
  messageEvents,
  getAllPersonalities,
  getLeaderboard,
  getAgentStats,
} from "../rooms.js";
import { CREATORS } from "./admin.js";

// System agents that should not trigger join notifications
const SYSTEM_AGENT_NAMES = new Set(["system"]);

// ── Model Hierarchy: task routing based on model capability ──────────────────
// Tier 1 (strategist): complex architecture, security, sensitive decisions
// Tier 2 (builder): feature implementation, debugging, code review
// Tier 3 (runner): simple tasks, monitoring, data collection, repetitive work
const MODEL_TIERS: Record<string, { tier: number; label: string }> = {
  // Tier 1 — Strategist
  "claude-opus-4-6": { tier: 1, label: "strategist" },
  "claude-opus-4-5": { tier: 1, label: "strategist" },
  o3: { tier: 1, label: "strategist" },
  "gpt-5": { tier: 1, label: "strategist" },
  "gemini-2.5-pro": { tier: 1, label: "strategist" },
  // Tier 2 — Builder
  "claude-sonnet-4-6": { tier: 2, label: "builder" },
  "claude-sonnet-4-5": { tier: 2, label: "builder" },
  "gpt-4o": { tier: 2, label: "builder" },
  "gemini-2.0-pro": { tier: 2, label: "builder" },
  codex: { tier: 2, label: "builder" },
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

    // Emit join notification when a real agent comes online from offline (skip viewers/sentinels)
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
      // Strip hostname for non-admins — leaks machine names
      hostname: isAdmin ? a.hostname : undefined,
    }));
    return c.json({ ok: true, agents });
  });

  // Expose hierarchy via API so agents and dashboards can use it
  app.get("/api/hierarchy", (c) => {
    const room = c.req.query("room");
    if (!room) return c.json({ error: "missing room" }, 400);
    const presence = getRoomPresence(room);
    const personalities = getAllPersonalities();
    const persMap: Record<string, any> = {};
    for (const p of personalities) persMap[p.name] = p;

    const agents = presence
      .filter(
        (a) =>
          !a.agent_name.includes("viewer") &&
          !a.agent_name.includes("synthetic") &&
          !a.agent_name.includes("enemy") &&
          !a.agent_name.includes("anti-") &&
          a.agent_name !== "Viewer" &&
          a.agent_name !== "Test" &&
          a.agent_name !== "RateLimitTest" &&
          !a.agent_name.includes("\ud83d")
      )
      .map((a) => {
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
        1: {
          label: "strategist",
          description:
            "Complex architecture, security audits, sensitive decisions, product strategy",
        },
        2: {
          label: "builder",
          description: "Feature implementation, debugging, code review, testing",
        },
        3: {
          label: "runner",
          description: "Monitoring, data collection, simple tasks, repetitive work",
        },
      },
      agents,
    });
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
        const leader = leaderboard.find(
          (l) => l.agent_name === agent.agent_name
        );

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

  // ── Display Name / Rename ──────────────────────────────────────────────

  app.post("/api/rename", async (c) => {
    const room = c.req.query("room");
    const name = c.req.query("name");
    if (!room || !name) return c.json({ error: "missing room or name" }, 400);
    const { display_name } = await c.req.json();
    if (!display_name || typeof display_name !== "string")
      return c.json({ error: "missing display_name" }, 400);
    const ok = setDisplayName(room, name, display_name.trim().slice(0, 32));
    return c.json({ ok });
  });

  // ── Reactions ──────────────────────────────────────────────────────────

  app.post("/api/react", async (c) => {
    const { message_id, emoji } = await c.req.json();
    const name = c.req.query("name");
    if (!name || !message_id || !emoji)
      return c.json({ error: "missing name, message_id, or emoji" }, 400);
    addReaction(message_id, name, emoji);

    // Emit reaction event for SSE
    const room = c.req.query("room");
    if (room) {
      messageEvents.emit("message", {
        room_code: room,
        message: {
          id: crypto.randomUUID(),
          from: name,
          content: `reacted ${emoji} to message`,
          ts: Date.now(),
          type: "REACTION",
          reply_to: message_id,
        },
      });
    }
    return c.json({ ok: true });
  });

  app.delete("/api/react", async (c) => {
    const { message_id } = await c.req.json();
    const name = c.req.query("name");
    if (!name || !message_id)
      return c.json({ error: "missing name or message_id" }, 400);
    removeReaction(message_id, name);
    return c.json({ ok: true });
  });

  app.get("/api/reactions/:messageId", (c) => {
    const messageId = c.req.param("messageId");
    const reactions = getMessageReactions(messageId);
    return c.json({ ok: true, reactions });
  });
}
