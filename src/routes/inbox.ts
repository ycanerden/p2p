import type { Hono } from "hono";
import {
  createOwner,
  getOwnerByEmail,
  getOwnerByUsername,
  isUsernameAvailable,
  registerAgent,
  getAgent,
  verifyAgentSecret,
  updateAgentStatus,
  updateAgentMetadata,
  deleteAgent,
  listAgentsByOwner,
  searchAgents,
  listAllPublicAgents,
  sendInboxMessage,
  getInboxMessages,
  getInboxStats,
  markInboxRead,
  markAllInboxRead,
  getInboxThread,
  deleteInboxMessage,
  getSentInboxMessages,
  generateAgentProfileMarkdown,
  validateAgentId,
} from "../rooms.js";
import type { Agent } from "../rooms.js";

// ── Auth Helpers ─────────────────────────────────────────────────────────────

// Verify Google ID token and return email + name
async function verifyGoogleToken(token: string): Promise<{ email: string; name: string } | null> {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return null;
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (data.aud !== clientId) return null;
    return { email: data.email, name: data.name || data.email.split("@")[0] };
  } catch {
    return null;
  }
}

// Extract agent secret from Authorization header
function getAgentAuth(c: any): string | null {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

// Authenticate agent from request, returns agent_id or null
function authenticateAgent(c: any): { agentId: string; secret: string } | null {
  const secret = getAgentAuth(c);
  if (!secret) return null;
  const agentId = c.req.query("agent_id") || c.req.header("X-Agent-ID");
  if (!agentId) return null;
  if (!verifyAgentSecret(agentId, secret)) return null;
  return { agentId, secret };
}

// Strip secret from agent object for public responses
function publicAgent(agent: Agent): Omit<Agent, "agent_secret"> {
  const { agent_secret, ...pub } = agent as any;
  return pub;
}

// ── Route Registration ───────────────────────────────────────────────────────

export function registerInboxRoutes(app: Hono) {

  // ── Owner Registration ──────────────────────────────────────────────────

  app.post("/api/owners/register", async (c) => {
    try {
      const body = await c.req.json();
      const { username, google_token } = body;
      if (!username || !google_token) return c.json({ error: "missing username or google_token" }, 400);

      // Validate username format
      if (!/^[a-z0-9_-]{2,24}$/.test(username)) {
        return c.json({ error: "invalid username — 2-24 chars, lowercase alphanumeric, hyphens, underscores" }, 400);
      }

      // Verify Google token
      const google = await verifyGoogleToken(google_token);
      if (!google) return c.json({ error: "invalid google token" }, 401);

      // Check if email already has an account
      const existing = getOwnerByEmail(google.email);
      if (existing) return c.json({ ok: true, owner: existing, existing: true });

      // Check username availability
      if (!isUsernameAvailable(username)) {
        return c.json({ error: "username taken" }, 409);
      }

      const owner = createOwner(username, google.email, google.name);
      return c.json({ ok: true, owner, existing: false });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.get("/api/owners/:username", (c) => {
    const username = c.req.param("username");
    const owner = getOwnerByUsername(username);
    if (!owner) return c.json({ error: "owner not found" }, 404);
    const agents = listAgentsByOwner(username).map(publicAgent);
    return c.json({ ok: true, owner, agents });
  });

  // ── Agent Registration ──────────────────────────────────────────────────

  app.post("/api/agents/register", async (c) => {
    try {
      const body = await c.req.json();
      const { name, display_name, google_token, owner: ownerOverride, metadata } = body;
      if (!name || !display_name) return c.json({ error: "missing name or display_name" }, 400);

      let ownerUsername: string;
      let ownerEmail: string | undefined;

      if (google_token) {
        // Dashboard flow: verify Google auth
        const google = await verifyGoogleToken(google_token);
        if (!google) return c.json({ error: "invalid google token" }, 401);
        const owner = getOwnerByEmail(google.email);
        if (!owner) return c.json({ error: "register as owner first via /api/owners/register" }, 400);
        ownerUsername = owner.username;
        ownerEmail = google.email;
      } else if (ownerOverride) {
        // CLI flow: use owner directly (less secure, for bootstrapping)
        ownerUsername = ownerOverride;
      } else {
        return c.json({ error: "missing google_token or owner" }, 400);
      }

      const result = registerAgent(name, ownerUsername, display_name, ownerEmail, metadata);
      const agent = getAgent(result.agent_id)!;
      const profileMarkdown = generateAgentProfileMarkdown(agent, result.secret);

      return c.json({
        ok: true,
        agent_id: result.agent_id,
        secret: result.secret,
        profile_markdown: profileMarkdown,
      });
    } catch (e: any) {
      const status = e.message.includes("already exists") ? 409 : 400;
      return c.json({ error: e.message }, status);
    }
  });

  app.get("/api/agents", (c) => {
    const owner = c.req.query("owner");
    const q = c.req.query("q");
    const limit = parseInt(c.req.query("limit") || "50");

    let agents: Agent[];
    if (owner) {
      agents = listAgentsByOwner(owner);
    } else if (q) {
      agents = searchAgents(q, limit);
    } else {
      agents = listAllPublicAgents(limit);
    }

    return c.json({ ok: true, agents: agents.map(publicAgent) });
  });

  app.get("/api/agents/:id", (c) => {
    const id = c.req.param("id");
    const agent = getAgent(id);
    if (!agent) return c.json({ error: "agent not found" }, 404);
    return c.json({ ok: true, agent: publicAgent(agent) });
  });

  app.patch("/api/agents/:id", async (c) => {
    const id = c.req.param("id");
    const auth = authenticateAgent(c);
    if (!auth || auth.agentId !== id) return c.json({ error: "unauthorized" }, 401);

    try {
      const body = await c.req.json();
      const updates: any = {};
      if (body.display_name) updates.display_name = body.display_name;
      if (body.metadata) updates.metadata_json = JSON.stringify(body.metadata);
      if (body.wake_webhook !== undefined) updates.wake_webhook = body.wake_webhook;
      if (body.is_public !== undefined) updates.is_public = body.is_public ? 1 : 0;

      updateAgentMetadata(id, updates);
      const agent = getAgent(id)!;
      return c.json({ ok: true, agent: publicAgent(agent) });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  app.delete("/api/agents/:id", async (c) => {
    const id = c.req.param("id");
    const auth = authenticateAgent(c);
    if (!auth || auth.agentId !== id) return c.json({ error: "unauthorized" }, 401);
    const deleted = deleteAgent(id);
    return c.json({ ok: deleted });
  });

  app.post("/api/agents/:id/heartbeat", async (c) => {
    const id = c.req.param("id");
    const auth = authenticateAgent(c);
    if (!auth || auth.agentId !== id) return c.json({ error: "unauthorized" }, 401);
    updateAgentStatus(id, "online");
    const stats = getInboxStats(id);
    return c.json({ ok: true, status: "online", inbox: stats });
  });

  // Download agent profile as markdown
  app.get("/api/agents/:id/profile.md", (c) => {
    const id = c.req.param("id");
    const auth = authenticateAgent(c);
    if (!auth || auth.agentId !== id) return c.json({ error: "unauthorized — only the agent owner can download the profile" }, 401);

    const agent = getAgent(id);
    if (!agent) return c.json({ error: "agent not found" }, 404);

    const md = generateAgentProfileMarkdown(agent, auth.secret);
    c.header("Content-Type", "text/markdown");
    c.header("Content-Disposition", `attachment; filename="${id.replace("@", "_")}.md"`);
    return c.body(md);
  });

  // ── Inbox: Send ─────────────────────────────────────────────────────────

  app.post("/api/inbox/send", async (c) => {
    const auth = authenticateAgent(c);
    if (!auth) return c.json({ error: "unauthorized — set Authorization: Bearer <secret> and agent_id query param" }, 401);

    try {
      const body = await c.req.json();
      const { to, content, thread_id, reply_to, msg_type } = body;
      if (!to || !content) return c.json({ error: "missing to or content" }, 400);

      const result = sendInboxMessage(auth.agentId, to, content, {
        threadId: thread_id,
        replyTo: reply_to,
        msgType: msg_type,
      });

      return c.json({ ok: true, ...result });
    } catch (e: any) {
      const status = e.message.includes("not found") ? 404 : 400;
      return c.json({ error: e.message }, status);
    }
  });

  // ── Inbox: Read ─────────────────────────────────────────────────────────

  app.get("/api/inbox", (c) => {
    const auth = authenticateAgent(c);
    if (!auth) return c.json({ error: "unauthorized" }, 401);

    const unreadOnly = c.req.query("unread_only") === "1";
    const from = c.req.query("from");
    const limit = parseInt(c.req.query("limit") || "50");
    const before = c.req.query("before") ? parseInt(c.req.query("before")!) : undefined;

    const messages = getInboxMessages(auth.agentId, { unreadOnly, from, limit, before });
    return c.json({ ok: true, messages });
  });

  app.get("/api/inbox/stats", (c) => {
    const auth = authenticateAgent(c);
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    const stats = getInboxStats(auth.agentId);
    return c.json({ ok: true, ...stats });
  });

  app.get("/api/inbox/sent", (c) => {
    const auth = authenticateAgent(c);
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    const limit = parseInt(c.req.query("limit") || "50");
    const messages = getSentInboxMessages(auth.agentId, limit);
    return c.json({ ok: true, messages });
  });

  app.post("/api/inbox/:id/read", (c) => {
    const auth = authenticateAgent(c);
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    const messageId = c.req.param("id");
    markInboxRead(auth.agentId, messageId);
    return c.json({ ok: true });
  });

  app.post("/api/inbox/read-all", async (c) => {
    const auth = authenticateAgent(c);
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    let threadId: string | undefined;
    try {
      const body = await c.req.json();
      threadId = body.thread_id;
    } catch { /* no body is fine */ }
    markAllInboxRead(auth.agentId, threadId);
    return c.json({ ok: true });
  });

  app.get("/api/inbox/thread/:id", (c) => {
    const auth = authenticateAgent(c);
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    const threadId = c.req.param("id");
    const messages = getInboxThread(threadId);
    return c.json({ ok: true, messages });
  });

  app.delete("/api/inbox/:id", (c) => {
    const auth = authenticateAgent(c);
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    const messageId = c.req.param("id");
    const deleted = deleteInboxMessage(auth.agentId, messageId);
    return c.json({ ok: deleted });
  });
}
