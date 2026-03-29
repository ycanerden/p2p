/**
 * Walkie-Talkie stdio MCP bridge
 * Calls simple REST endpoints on the walkie-talkie server.
 *
 * Env vars:
 *   SERVER_URL — base URL (default: http://localhost:3001)
 *   ROOM       — room code
 *   NAME       — agent name
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3001";
const ROOM = process.env.ROOM || "";
const NAME = process.env.NAME || "Agent";
const BASE = `${SERVER_URL}/api`;
let connectionMode: "relay" | "p2p" = process.env.CONNECTION_MODE === "p2p" ? "p2p" : "relay";

// Message buffer for SSE updates
const messageBuffer: Array<{from: string; to?: string; content: string; ts: number}> = [];

async function startEventStream() {
  const params = `?room=${ROOM}&name=${NAME}`;
  console.error(`[sse] Connecting to ${SERVER_URL}/api/stream`);

  try {
    const response = await fetch(`${SERVER_URL}/api/stream${params}`);
    if (!response.ok) {
      console.error(`[sse] Server returned ${response.status}`);
      setTimeout(startEventStream, 5000);
      return;
    }

    if (!response.body) {
      console.error(`[sse] No response body`);
      setTimeout(startEventStream, 5000);
      return;
    }

    console.error(`[sse] Connected, listening for messages`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let streamBuffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        console.error(`[sse] Stream closed by server`);
        break;
      }

      streamBuffer += decoder.decode(value, { stream: true });
      const parts = streamBuffer.split("\n\n");
      streamBuffer = parts.pop() || "";

      for (const part of parts) {
        // Skip empty parts
        if (!part.trim()) continue;

        // Process message events
        if (part.includes("event: message")) {
          const lines = part.split("\n");
          const dataLine = lines.find(line => line.startsWith("data: "));
          if (dataLine) {
            try {
              const msg = JSON.parse(dataLine.slice(6));
              
              // Intercept FILE_SYNC for P2P code updates
              try {
                const parsedContent = JSON.parse(msg.content);
                if (parsedContent.type === "FILE_SYNC") {
                  const targetPath = path.resolve(process.cwd(), parsedContent.filename);
                  if (targetPath.startsWith(process.cwd())) {
                    await fs.mkdir(path.dirname(targetPath), { recursive: true });
                    await fs.writeFile(targetPath, parsedContent.content, "utf-8");
                    console.error(`[sse] 🔄 Received code update for ${parsedContent.filename} from ${msg.from}`);
                    messageBuffer.push({
                      from: "SYSTEM",
                      content: `Peer ${msg.from} broadcasted a code update for ${parsedContent.filename}. The file was updated automatically on your local drive.`,
                      ts: Date.now()
                    });
                  }
                  continue;
                }
              } catch(e) {
                // Not a JSON message or not FILE_SYNC, proceed normally
              }

              messageBuffer.push(msg);
            } catch (e) {
              console.error(`[sse] Failed to parse message: ${e}`);
            }
          }
        }
        // Heartbeats are just for keep-alive, no action needed
      }
    }
  } catch (e) {
    console.error(`[sse] Error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Always retry after delay, whether stream closed or error occurred
  console.error(`[sse] Reconnecting in 5s...`);
  setTimeout(startEventStream, 5000);
}

// Start the SSE stream in the background
startEventStream();

const mcp = new Server({ name: "walkie-talkie", version: "1.0.0" }, { capabilities: { tools: {} } });

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "room_status",
      description: "Check if your partner has joined the room.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "send_to_partner",
      description: "Send a message to your partner's AI. They will receive it on their next get_partner_messages() call.",
      inputSchema: {
        type: "object" as const,
        properties: { 
          message: { type: "string", description: "The message to send" },
          to: { type: "string", description: "Optional: specific recipient name for private/targeted messaging" }
        },
        required: ["message"],
      },
    },
    {
      name: "get_partner_messages",
      description: "Get unread messages from your partner's AI.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "publish_card",
      description: "Broadcast your Agent Card (skills, model, availability) to the room.",
      inputSchema: {
        type: "object" as const,
        properties: {
          card: {
            type: "object",
            properties: {
              agent: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  model: { type: "string" },
                  tool: { type: "string" },
                },
                required: ["name", "model"],
              },
              skills: { type: "array", items: { type: "string" } },
              capabilities: { type: "object" },
            },
            required: ["agent"],
          },
        },
        required: ["card"],
      },
    },
    {
      name: "get_partner_cards",
      description: "Get Agent Cards from all partners in the room. Shows their models, skills, and capabilities.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "handoff_to_partner",
      description: "Securely package and hand off a project, task, or context to a specific partner agent.",
      inputSchema: {
        type: "object" as const,
        properties: {
          targetAgent: { type: "string", description: "The exact name of the agent to hand off to" },
          projectId: { type: "string", description: "A unique identifier for the project" },
          founder: { type: "string", description: "The name of the founder (e.g., Jorel, Simon)" },
          taskType: { type: "string", description: "The type of task (e.g., build, audit, deploy)" },
          payload: { type: "string", description: "The actual code, plan, or data being handed off" },
        },
        required: ["targetAgent", "projectId", "founder", "taskType", "payload"],
      },
    },
    {
      name: "view_trust_dashboard",
      description: "Return the HTML for the Tokora Trust Dashboard for the CEO to review security settings.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "broadcast_code_update",
      description: "Send a code update directly to all partner agents in the room over the P2P mesh. Their local files will be automatically updated!",
      inputSchema: {
        type: "object" as const,
        properties: {
          filename: { type: "string", description: "The relative path to the file to update (e.g., src/index.ts)" },
          content: { type: "string", description: "The complete new content of the file" },
        },
        required: ["filename", "content"],
      },
    },
    {
      name: "agent-bridge.share_file",
      description: "Share a local file and return a retrievable stream URL.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Local file path (relative or absolute)." },
          expires_in: { type: "number", description: "Requested TTL in seconds (advisory)." },
        },
        required: ["path"],
      },
    },
    {
      name: "agent-bridge.assign_task",
      description: "Assign a task to a peer and persist it in the room task board.",
      inputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Task title." },
          description: { type: "string", description: "Task details and acceptance criteria." },
          files: { type: "array", items: { type: "string" }, description: "Related file paths." },
          to: { type: "string", description: "Optional target agent name." },
          due_in_hours: { type: "number", description: "Optional due window in hours (default: 24)." },
        },
        required: ["title", "description"],
      },
    },
    {
      name: "agent-bridge.p2p_status",
      description: "Get the current bridge mode and connected peers.",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const params = `?room=${ROOM}&name=${NAME}`;

  try {
    if (name === "room_status") {
      const res = await fetch(`${BASE}/status${params}`);
      const data = await res.json();
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "send_to_partner") {
      const { message, to } = (args || {}) as { message: string; to?: string };
      if (!message || !message.trim()) {
        return { content: [{ type: "text" as const, text: "Error: message is required" }], isError: true };
      }

      const body: { message: string; to?: string } = { message: message.trim() };
      if (to?.trim()) body.to = to.trim();

      const res = await fetch(`${BASE}/send${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { ok?: boolean; id?: string; error?: string };
      if (!data.ok) {
        return { content: [{ type: "text" as const, text: `Error: ${data.error || "send_failed"}` }], isError: true };
      }
      return {
        content: [{ type: "text" as const, text: `Sent ✓${body.to ? ` (to ${body.to})` : ""}\nMessage ID: ${data.id || "unknown"}` }]
      };
    }

    if (name === "publish_card") {
      const { card } = args as { card: any };
      const res = await fetch(`${BASE}/publish${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card }),
      });
      const data = await res.json();
      return { content: [{ type: "text" as const, text: data.ok ? `Card published ✓ (updated: ${new Date(data.updated_at).toISOString()})` : `Error: ${data.error}` }] };
    }

    if (name === "get_partner_cards") {
      const res = await fetch(`${BASE}/cards${params}`);
      const data = await res.json() as { ok: boolean; cards?: Array<{name: string; card: any; updated_at: number}>; error?: string };
      if (!data.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: data.error }) }], isError: true };
      }
      if (!data.cards?.length) {
        return { content: [{ type: "text" as const, text: "No partner cards found." }] };
      }
      const formatted = data.cards
        .map((c) => `[${c.name}]\nModel: ${c.card?.agent?.model || 'unknown'}\nSkills: ${(c.card?.skills || []).join(', ') || 'none'}\nUpdated: ${new Date(c.updated_at).toISOString()}`)
        .join("\n\n---\n\n");
      return { content: [{ type: "text" as const, text: formatted }] };
    }

    if (name === "get_partner_messages") {
      // Check buffer first (SSE updates)
      if (messageBuffer.length > 0) {
        const msgs = [...messageBuffer];
        messageBuffer.length = 0;
        const formatted = msgs
          .map((m) => `[${m.from}${m.to ? ` (to: ${m.to})` : ""} @ ${new Date(m.ts).toISOString()}]\n${m.content}`)
          .join("\n\n---\n\n");
        return { content: [{ type: "text" as const, text: formatted }] };
      }

      // Fallback to polling if buffer is empty
      const res = await fetch(`${BASE}/messages${params}`);
      const data = await res.json() as { ok: boolean; messages?: Array<{from: string; to?: string; content: string; ts: number}> };
      if (!data.ok || !data.messages?.length) {
        return { content: [{ type: "text" as const, text: "No new messages." }] };
      }
      const formatted = data.messages
        .map((m) => `[${m.from}${m.to ? ` (to: ${m.to})` : ""} @ ${new Date(m.ts).toISOString()}]\n${m.content}`)
        .join("\n\n---\n\n");
      return { content: [{ type: "text" as const, text: formatted }] };
    }

    if (name === "view_trust_dashboard") {
      try {
        const fs = await import("fs/promises");
        const path = await import("path");
        // Try reading from parent directory or local based on setup
        const dashboardPath = path.resolve(process.cwd(), "trust-dashboard.html");
        const html = await fs.readFile(dashboardPath, "utf-8");
        return { content: [{ type: "text" as const, text: html }] };
      } catch (e) {
        // Fallback mock if file isn't physically present on this specific agent's node yet
        const mockHtml = `<html><body><h1>Tokora Trust Dashboard</h1><p>Status: ENFORCED</p><button style="background:red;color:white;padding:20px;font-size:24px;border-radius:8px;">KILL-SWITCH: SEVER MESH</button></body></html>`;
        return { content: [{ type: "text" as const, text: mockHtml }] };
      }
    }

    if (name === "handoff_to_partner") {
      const { targetAgent, projectId, founder, taskType, payload } = args as {
        targetAgent: string;
        projectId: string;
        founder: string;
        taskType: string;
        payload: string;
      };

      const handoffMsg = {
        type: "HANDOFF",
        projectId,
        founder,
        taskType,
        payload,
        handoffFrom: NAME,
        timestamp: Date.now()
      };

      const res = await fetch(`${BASE}/send${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: JSON.stringify(handoffMsg),
          to: targetAgent,
          type: "HANDOFF"
        }),
      });

      const data = await res.json();
      if (!data.ok) {
        return { content: [{ type: "text" as const, text: `Error: ${data.error}` }], isError: true };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `✓ Handoff sent to ${targetAgent}\nProject: ${projectId}\nTask Type: ${taskType}\nMessage ID: ${data.id}`
          }
        ]
      };
    }

    if (name === "broadcast_code_update") {
      const { filename, content } = args as { filename: string; content: string };
      const syncMessage = {
        type: "FILE_SYNC",
        filename,
        content
      };
      
      const res = await fetch(`${BASE}/send${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: JSON.stringify(syncMessage) }),
      });
      const data = await res.json();
      return { content: [{ type: "text" as const, text: data.ok ? `Code update for ${filename} broadcasted to all partners! 🚀` : `Error broadcasting code: ${data.error}` }] };
    }

    if (name === "agent-bridge.share_file") {
      const { path: inputPath, expires_in } = (args || {}) as { path: string; expires_in?: number };
      if (!inputPath || !inputPath.trim()) {
        return { content: [{ type: "text" as const, text: "Error: path is required" }], isError: true };
      }

      const resolvedPath = path.resolve(process.cwd(), inputPath);
      const fileContent = await fs.readFile(resolvedPath, "utf-8");
      const filename = path.basename(resolvedPath);

      const res = await fetch(`${BASE}/files/upload${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename,
          content: fileContent,
          mime_type: "text/plain",
          description: `Shared via agent-bridge.share_file by ${NAME}`
        }),
      });
      const data = await res.json() as { ok?: boolean; file_id?: string; error?: string };
      if (!data.ok || !data.file_id) {
        return { content: [{ type: "text" as const, text: `Error: ${data.error || "file_share_failed"}` }], isError: true };
      }

      const ttlSeconds = Number.isFinite(expires_in) && (expires_in as number) > 0 ? Math.floor(expires_in as number) : 3600;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            file_id: data.file_id,
            stream_url: `${BASE}/files/${data.file_id}`,
            expires_in: ttlSeconds
          }, null, 2)
        }]
      };
    }

    if (name === "agent-bridge.assign_task") {
      const {
        title,
        description,
        files,
        to,
        due_in_hours
      } = (args || {}) as {
        title: string;
        description: string;
        files?: string[];
        to?: string;
        due_in_hours?: number;
      };

      if (!title?.trim() || !description?.trim()) {
        return { content: [{ type: "text" as const, text: "Error: title and description are required" }], isError: true };
      }

      let targetAgent = to?.trim();
      if (!targetAgent) {
        const statusRes = await fetch(`${BASE}/status${params}`);
        const statusData = await statusRes.json() as { partners?: Array<{ name: string }> };
        targetAgent = statusData.partners?.map((p) => p.name).find((n) => n !== NAME);
      }
      if (!targetAgent) {
        return { content: [{ type: "text" as const, text: "Error: no target peer available in room" }], isError: true };
      }

      const safeTitle = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const taskId = `ab-${safeTitle || "task"}-${Date.now().toString(36)}`;
      const dueHours = Number.isFinite(due_in_hours) && (due_in_hours as number) > 0 ? Number(due_in_hours) : 24;
      const dueDate = Date.now() + Math.floor(dueHours * 60 * 60 * 1000);

      const assignRes = await fetch(`${SERVER_URL}/tasks/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room_code: ROOM,
          agent_name: targetAgent,
          task_id: taskId,
          task_title: title.trim(),
          due_date: dueDate
        }),
      });
      const assignData = await assignRes.json() as { task_id?: string; error?: string };
      if (assignRes.status >= 400) {
        return { content: [{ type: "text" as const, text: `Error assigning task: ${assignData.error || assignRes.status}` }], isError: true };
      }

      const taskBody = [
        `Task: ${title.trim()}`,
        `Details: ${description.trim()}`,
        files?.length ? `Files: ${files.join(", ")}` : ""
      ].filter(Boolean).join("\n");

      await fetch(`${BASE}/send${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: taskBody,
          type: "TASK",
          to: targetAgent
        }),
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            task_id: assignData.task_id || taskId,
            status: "accepted",
            assigned_to: targetAgent,
            due_date: dueDate
          }, null, 2)
        }]
      };
    }

    if (name === "agent-bridge.p2p_status") {
      const start = Date.now();
      const statusRes = await fetch(`${BASE}/status${params}`);
      const statusData = await statusRes.json() as {
        connected?: boolean;
        partners?: Array<{ name: string }>;
      };
      const latency = Date.now() - start;

      const connectedPeers = (statusData.partners || [])
        .filter((p) => p.name !== NAME)
        .map((p) => ({
          name: p.name,
          latency,
          data_channel_state: connectionMode === "p2p" ? "open" : "relay",
        }));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            connection_mode: connectionMode,
            connected: Boolean(statusData.connected),
            connected_peers: connectedPeers
          }, null, 2)
        }]
      };
    }

    return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }] };
  } catch (e: unknown) {
    return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
  }
});

const transport = new StdioServerTransport();
await mcp.connect(transport);
