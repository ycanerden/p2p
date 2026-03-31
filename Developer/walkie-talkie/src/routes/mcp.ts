import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  ensureRoom, joinRoom, appendMessage, getMessages, getRoomStatus,
  getAllMessages, publishCard, getPartnerCards, updatePresence, getRoomPresence,
  addReaction, shareFile, getRoomFiles, createHandoff, acceptHandoff, getHandoff,
  getLeaderboard, registerAgent, searchAgents, pinMessage, registerWebhook,
  searchMessages, trackAgentActivity,
} from "../rooms.js";
import { assignTask, updateTaskStatus, getAllAgentTasks, getRoomTasks } from "../room-manager.js";
import { checkRateLimit } from "../middleware.js";

const mcp = new Hono();

mcp.all("/mcp", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");

  if (!room || !name) {
    return c.json({ error: "Missing required query params: ?room=CODE&name=YOUR_NAME" }, 400);
  }

  ensureRoom(room);
  joinRoom(room, name);

  const server = new McpServer({ name: "mesh", version: "3.0.0" });

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
      if (!checkRateLimit(`send:${room}:${name}`, 30, 60 * 1000, name)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "rate_limit_exceeded_please_wait" }) }], isError: true };
      }
      const result = appendMessage(room, name, message, to, type || "BROADCAST");
      if (!result.ok) return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify({ status: "sent", message_id: result.id, targeted: !!to }) }] };
    }
  );

  // Tool: get_partner_messages
  server.tool("get_partner_messages", "Get unread messages from your partner's AI. Returns [] if no new messages.", {}, async () => {
    if (!checkRateLimit(`get_msgs:${room}:${name}`, 10, 60 * 1000, name)) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "rate_limit_exceeded_please_wait" }) }], isError: true };
    }
    const result = getMessages(room, name);
    if (!result.ok) return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(result.messages) }] };
  });

  // Tool: publish_card
  server.tool("publish_card", "Broadcast your Agent Card (metadata) to the room.", {
    card: z.object({
      agent: z.object({ name: z.string(), model: z.string(), tool: z.string().optional() }).passthrough(),
      skills: z.array(z.string()).optional(),
      availability: z.string().optional(),
      capabilities: z.record(z.any()).optional(),
    }).passthrough().describe("Your Agent Card metadata")
  }, async ({ card }) => {
    const result = publishCard(room, name, card);
    if (!result.ok) return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify({ status: "published", updated_at: result.updated_at }) }] };
  });

  // Tool: get_partner_cards
  server.tool("get_partner_cards", "Get Agent Cards from all partners in the room.", {}, async () => {
    const result = getPartnerCards(room, name);
    if (!result.ok) return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(result.cards) }] };
  });

  // Tool: get_briefing
  server.tool("get_briefing", "Get a compact briefing of recent room activity.", {
    hours: z.number().optional().describe("How many hours back to summarize (default: 2)"),
  }, async ({ hours }) => {
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
  });

  // Tool: react_to_message
  server.tool("react_to_message", "React to a message with an emoji.", {
    message_id: z.string(), emoji: z.string(),
  }, async ({ message_id, emoji }) => {
    addReaction(message_id, name, emoji);
    return { content: [{ type: "text", text: JSON.stringify({ status: "reacted", emoji }) }] };
  });

  // Tool: send_heartbeat
  server.tool("send_heartbeat", "Send a presence heartbeat to show you are online.", {}, async () => {
    updatePresence(room, name, "online");
    return { content: [{ type: "text", text: JSON.stringify({ status: "online", agent: name }) }] };
  });

  // Tool: get_presence
  server.tool("get_presence", "Check which agents are currently online in this room.", {}, async () => {
    return { content: [{ type: "text", text: JSON.stringify(getRoomPresence(room)) }] };
  });

  // Tool: share_file
  server.tool("share_file", "Share a file with other agents in the room. Max 512KB.", {
    filename: z.string(), content: z.string(), description: z.string().optional(),
  }, async ({ filename, content, description }) => {
    const result = shareFile(room, name, filename, content, "text/plain", description || "");
    if (result.ok) trackAgentActivity(name, "file_share");
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  // Tool: get_room_files
  server.tool("get_room_files", "List all files shared in this room.", {}, async () => {
    const files = getRoomFiles(room);
    return { content: [{ type: "text", text: JSON.stringify({ files, count: files.length }) }] };
  });

  // Tool: handoff_to_agent
  server.tool("handoff_to_agent", "Hand off your work to another agent with full context.", {
    to_agent: z.string(), summary: z.string(),
    files_changed: z.array(z.string()).optional(),
    decisions_made: z.array(z.string()).optional(),
    blockers: z.array(z.string()).optional(),
  }, async ({ to_agent, summary, files_changed, decisions_made, blockers }) => {
    const handoff = createHandoff(room, name, to_agent, summary, {}, files_changed || [], decisions_made || [], blockers || []);
    trackAgentActivity(name, "handoff");
    return { content: [{ type: "text", text: JSON.stringify({ status: "handed_off", handoff_id: handoff.handoff_id }) }] };
  });

  // Tool: accept_handoff
  server.tool("accept_handoff", "Accept a handoff assigned to you.", {
    handoff_id: z.string(),
  }, async ({ handoff_id }) => {
    const result = acceptHandoff(handoff_id, name);
    if (result.ok) {
      const h = getHandoff(handoff_id);
      return { content: [{ type: "text", text: JSON.stringify({ status: "accepted", handoff: h }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }], isError: true };
  });

  // Tool: get_leaderboard
  server.tool("get_leaderboard", "See the agent leaderboard.", {}, async () => {
    return { content: [{ type: "text", text: JSON.stringify(getLeaderboard(10)) }] };
  });

  // Tool: register_in_directory
  server.tool("register_in_directory", "Register yourself in the global agent directory.", {
    skills: z.array(z.string()), description: z.string(),
  }, async ({ skills, description }) => {
    const profile = registerAgent({
      agent_id: `${name}-${room}`, agent_name: name, model: "unknown",
      skills: skills.join(","), description, contact_room: room, status: "available",
    });
    return { content: [{ type: "text", text: JSON.stringify({ status: "registered", profile }) }] };
  });

  // Tool: find_agents
  server.tool("find_agents", "Search the global agent directory.", {
    query: z.string(),
  }, async ({ query }) => {
    const agents = searchAgents(query);
    return { content: [{ type: "text", text: JSON.stringify({ found: agents.length, agents }) }] };
  });

  // Tool: pin_message
  server.tool("pin_message", "Pin an important message in the room.", {
    message_id: z.string(),
  }, async ({ message_id }) => {
    pinMessage(room, message_id, name);
    return { content: [{ type: "text", text: JSON.stringify({ status: "pinned", message_id }) }] };
  });

  // Tool: register_webhook
  server.tool("register_webhook", "Register a webhook URL for push notifications.", {
    webhook_url: z.string(), events: z.string().optional(),
  }, async ({ webhook_url, events }) => {
    registerWebhook(room, name, webhook_url, events || "message");
    return { content: [{ type: "text", text: JSON.stringify({ status: "webhook_registered", url: webhook_url }) }] };
  });

  // Tool: get_my_tasks
  server.tool("get_my_tasks", "Get all tasks assigned to you.", {}, async () => {
    const tasks = getAllAgentTasks(name);
    const roomTasks = getRoomTasks(room);
    return { content: [{ type: "text", text: JSON.stringify({ my_tasks: tasks, room_tasks: roomTasks, my_count: tasks.length, room_count: roomTasks.length }) }] };
  });

  // Tool: assign_task_to_agent
  server.tool("assign_task_to_agent", "Assign a task to another agent.", {
    agent_name: z.string(), task_id: z.string(), task_title: z.string(),
  }, async ({ agent_name, task_id, task_title }) => {
    const task = assignTask(room, agent_name, task_id, task_title, Date.now() + 24 * 60 * 60 * 1000);
    return { content: [{ type: "text", text: JSON.stringify({ status: "assigned", task }) }] };
  });

  // Tool: update_task
  server.tool("update_task", "Update the status of a task.", {
    task_id: z.string(), status: z.enum(["pending", "in_progress", "blocked", "done"]),
  }, async ({ task_id, status }) => {
    updateTaskStatus(room, name, task_id, status);
    return { content: [{ type: "text", text: JSON.stringify({ status: "updated", task_id, new_status: status }) }] };
  });

  // Tool: search_messages
  server.tool("search_messages", "Search through message history in this room.", {
    query: z.string(), limit: z.number().optional(),
  }, async ({ query, limit }) => {
    const results = searchMessages(room, query, limit || 20);
    return { content: [{ type: "text", text: JSON.stringify({ results, count: results.length, query }) }] };
  });

  // Tool: room_status
  server.tool("room_status", "Check if your partner has joined the room.", {}, async () => {
    const result = getRoomStatus(room, name);
    if (!result.ok) return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify({ connected: result.connected, partners: result.partners, message_count: result.message_count }) }] };
  });

  // Tool: propose_decision
  server.tool("propose_decision", "Propose a structured decision to your team.", {
    question: z.string(), context: z.string(),
    options: z.array(z.object({
      label: z.string(), description: z.string(),
      effort: z.string().optional(), tradeoff: z.string().optional(),
    })).min(2).max(3),
    recommendation: z.string(),
  }, async ({ question, context, options, recommendation }) => {
    const lines = [
      `🤔 DECISION NEEDED — ${question}`, ``, `Context: ${context}`, ``,
      ...options.flatMap(o => [
        `${o.label}) ${o.description}`,
        o.effort ? `   Effort: ${o.effort}` : "",
        o.tradeoff ? `   Tradeoff: ${o.tradeoff}` : "",
      ].filter(Boolean)),
      ``, `Recommendation: ${recommendation}`,
    ].join("\n");
    const result = appendMessage(room, name, lines, undefined, "TASK");
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, message_id: result.id }) }] };
  });

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

export default mcp;
