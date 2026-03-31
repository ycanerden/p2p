import { Hono } from "hono";
import {
  registerAgent, searchAgents, getAvailableAgents, getAllAgents,
  getAgentProfile, updateAgentStatus, getAllAgentProfiles, getProductivityReport,
  savePersonality, getPersonality, getAllPersonalities, generateIdentityBlock,
} from "../rooms.js";
import { getAllAgentTasks } from "../room-manager.js";

const directory = new Hono();

const stripDirectorySensitive = (a: any) => {
  const { contact_room, ...safe } = a;
  return safe;
};

directory.post("/api/directory/register", async (c) => {
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

directory.get("/api/directory", (c) => {
  const q = c.req.query("q");
  const agents = (q ? searchAgents(q) : getAllAgents()).map(stripDirectorySensitive);
  return c.json({ ok: true, agents, count: agents.length });
});

directory.get("/api/directory/available", (c) => {
  return c.json({ ok: true, agents: getAvailableAgents().map(stripDirectorySensitive), count: getAvailableAgents().length });
});

directory.get("/api/directory/:agentId", (c) => {
  const profile = getAgentProfile(c.req.param("agentId"));
  if (!profile) return c.json({ error: "agent not found" }, 404);
  return c.json({ ok: true, profile: stripDirectorySensitive(profile) });
});

directory.put("/api/directory/:agentId/status", async (c) => {
  const { status } = await c.req.json();
  updateAgentStatus(c.req.param("agentId"), status);
  return c.json({ ok: true });
});

// ── Personality ────────────────────────────────────────────────────────────

directory.post("/api/personality", async (c) => {
  const name = c.req.query("name");
  if (!name) return c.json({ error: "missing name" }, 400);
  const { personality, system_prompt, skills, model, tool } = await c.req.json();
  savePersonality(name, personality || "", system_prompt || "", skills || "", model, tool);
  return c.json({ ok: true, name });
});

directory.get("/api/personality", (c) => {
  const name = c.req.query("name");
  const stripSensitive = (p: any) => {
    const { system_prompt, ...safe } = p;
    return safe;
  };
  if (name) {
    const p = getPersonality(name);
    return p ? c.json({ ok: true, ...stripSensitive(p) }) : c.json({ error: "not found" }, 404);
  }
  return c.json({ ok: true, agents: getAllPersonalities().map(stripSensitive) });
});

directory.get("/api/personality/identity-block", (c) => {
  const name = c.req.query("name");
  if (!name) return c.json({ error: "missing name" }, 400);
  return new Response(generateIdentityBlock(name), { headers: { "Content-Type": "text/plain" } });
});

// ── Analytics ──────────────────────────────────────────────────────────────

directory.get("/api/analytics", (c) => {
  const agents = getAllAgentProfiles();
  const summary = agents.map(a => ({
    name: a.agent_name, model: a.model, tasks_done: a.tasks_completed,
    reputation: a.reputation_score, last_seen: a.last_seen,
  }));
  return c.json({ ok: true, agents: summary });
});

directory.get("/api/analytics/:name", (c) => {
  const name = c.req.param("name");
  const stats = getProductivityReport(name);
  const tasks = getAllAgentTasks(name);
  return c.json({ ok: true, stats, tasks });
});

export default directory;
