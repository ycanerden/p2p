#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";
import { hostname } from "node:os";

// ── Types ────────────────────────────────────────────────────────────────────

interface BridgeConfig {
  api: string;
  room: string;
  name: string;
  agent_token?: string;
  max_concurrent: number;
  poll_interval_ms: number;
  workspace_root: string;
}

interface QueueTask {
  room_code: string;
  task_id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  claimed_by: string | null;
  created_by: string;
  created_at: number;
}

interface TaskComplete {
  task_id: string;
  summary: string;
  pr_url?: string;
  branch_name?: string;
}

// ── Config ───────────────────────────────────────────────────────────────────

const CONFIG_DIR = join(process.env.HOME || "~", ".conductor");
const CONFIG_PATH = join(CONFIG_DIR, "mesh.json");

function loadConfig(): BridgeConfig | null {
  if (existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    } catch {
      return null;
    }
  }
  return null;
}

function saveConfig(config: BridgeConfig) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ── Interactive Setup ────────────────────────────────────────────────────────

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

async function interactiveSetup(): Promise<BridgeConfig> {
  console.log("\n  Welcome to Mesh x Conductor\n");

  const api = await prompt("Mesh server URL", "https://trymesh.chat");
  const room = await prompt("Room code");
  if (!room) {
    console.error("  Room code is required.");
    process.exit(1);
  }
  const name = await prompt("Your name", `${hostname()}-conductor`);
  const password = await prompt("Room password (if any)");
  const workspaceRoot = await prompt("Workspace root", process.cwd());
  const maxConcurrent = parseInt(await prompt("Max concurrent tasks", "3")) || 3;

  // If password provided, verify and get token
  let agentToken: string | undefined;
  if (password) {
    try {
      const res = await fetch(`${api}/api/rooms/${room}/verify-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        const data = await res.json() as any;
        agentToken = data.access_token;
        console.log("  Password verified.");
      } else {
        console.error("  Wrong password. You can still connect — the room may not require one.");
      }
    } catch {
      console.error("  Could not verify password. Continuing without auth token.");
    }
  }

  const config: BridgeConfig = {
    api,
    room,
    name,
    agent_token: agentToken,
    max_concurrent: maxConcurrent,
    poll_interval_ms: 10000,
    workspace_root: workspaceRoot,
  };

  saveConfig(config);
  console.log(`  Config saved to ${CONFIG_PATH}\n`);
  return config;
}

// ── CLI arg parsing ──────────────────────────────────────────────────────────

function parseArgs(): Partial<BridgeConfig> {
  const args = process.argv.slice(2);
  const parsed: Partial<BridgeConfig> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--room": parsed.room = args[++i]; break;
      case "--name": parsed.name = args[++i]; break;
      case "--api": parsed.api = args[++i]; break;
      case "--workspace-root": parsed.workspace_root = args[++i]; break;
      case "--max-concurrent": parsed.max_concurrent = parseInt(args[++i]!); break;
      case "--poll-interval": parsed.poll_interval_ms = parseInt(args[++i]!) * 1000; break;
      case "--help":
        console.log(`
  mesh-conductor — Bridge Conductor workspaces to a Mesh room

  Usage:
    mesh-conductor                         # Interactive setup (first run)
    mesh-conductor --room my-room          # Override room from saved config
    mesh-conductor --room my-room --name v # Use specific name

  Options:
    --room <code>           Mesh room code
    --name <name>           Your conductor name
    --api <url>             Mesh server URL (default: https://trymesh.chat)
    --workspace-root <dir>  Path to Conductor workspaces
    --max-concurrent <n>    Max tasks to run at once (default: 3)
    --poll-interval <sec>   Poll interval in seconds (default: 10)
    --help                  Show this help
`);
        process.exit(0);
    }
  }
  return parsed;
}

// ── Workspace Discovery ──────────────────────────────────────────────────────

function discoverWorkspaces(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => join(root, d.name))
      .filter((p) => existsSync(join(p, ".context")) || existsSync(join(p, ".git")));
  } catch {
    return [];
  }
}

function getWorkspaceStatus(wsPath: string): "idle" | "busy" | "complete" {
  const contextDir = join(wsPath, ".context");
  if (existsSync(join(contextDir, "task-complete.json"))) return "complete";
  if (existsSync(join(contextDir, "current-task.json"))) return "busy";
  return "idle";
}

function assignTaskToWorkspace(wsPath: string, task: QueueTask, config: BridgeConfig) {
  const contextDir = join(wsPath, ".context");
  if (!existsSync(contextDir)) mkdirSync(contextDir, { recursive: true });

  const assignment = {
    task_id: task.task_id,
    title: task.title,
    description: task.description,
    branch_name: `mesh/${task.task_id}`,
    assigned_at: Date.now(),
    room: task.room_code,
  };

  writeFileSync(join(contextDir, "current-task.json"), JSON.stringify(assignment, null, 2));

  // Write worker instructions — tells the agent what to do when it starts
  const instructions = `# Mesh Task Assignment

You have been assigned a task by the Mesh task queue. Work autonomously.

## Your Task

- **ID**: ${task.task_id}
- **Title**: ${task.title}
- **Description**: ${task.description || "See title."}
- **Branch**: \`mesh/${task.task_id}\`

## Instructions

1. Create branch \`mesh/${task.task_id}\` from main
2. Implement the task described above
3. Commit your changes with a clear message
4. Push the branch
5. When done, write \`.context/task-complete.json\`:
   \`\`\`json
   {
     "task_id": "${task.task_id}",
     "summary": "Brief description of what you did",
     "branch_name": "mesh/${task.task_id}",
     "pr_url": ""
   }
   \`\`\`

## Rules

- Do NOT poll Mesh for messages or chat. Just do the work.
- If you are blocked, write to \`.context/task-complete.json\` with \`"blocked": true\` and a \`"blocker"\` field explaining why.
- Stay focused on this one task. Do not start other work.
- Be token-efficient: no summaries, no status updates, just ship.
`;

  writeFileSync(join(contextDir, "notes.md"), instructions);
}

function readTaskComplete(wsPath: string): TaskComplete | null {
  const path = join(wsPath, ".context", "task-complete.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function cleanupWorkspaceTask(wsPath: string) {
  const contextDir = join(wsPath, ".context");
  const files = ["current-task.json", "task-complete.json"];
  for (const f of files) {
    const p = join(contextDir, f);
    if (existsSync(p)) unlinkSync(p);
  }
}

// ── API Client ───────────────────────────────────────────────────────────────

class MeshClient {
  constructor(
    private api: string,
    private room: string,
    private name: string,
    private token?: string
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  async heartbeat() {
    await fetch(
      `${this.api}/api/heartbeat?room=${this.room}&name=${this.name}`,
      { method: "POST", headers: this.headers(), body: JSON.stringify({ status: "online", role: "conductor", hostname: hostname() }) }
    ).catch(() => {});
  }

  async getOpenTasks(): Promise<QueueTask[]> {
    try {
      const res = await fetch(`${this.api}/api/queue/tasks?room=${this.room}&status=open`, { headers: this.headers() });
      const data = await res.json() as any;
      return data.tasks || [];
    } catch {
      return [];
    }
  }

  async claimTask(taskId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.api}/api/queue/claim?room=${this.room}&name=${this.name}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ task_id: taskId }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async updateTask(taskId: string, updates: Record<string, any>): Promise<boolean> {
    try {
      const res = await fetch(`${this.api}/api/queue/tasks/${taskId}?room=${this.room}&name=${this.name}`, {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify(updates),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async releaseTask(taskId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.api}/api/queue/release?room=${this.room}&name=${this.name}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ task_id: taskId }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async sendMessage(message: string) {
    await fetch(`${this.api}/api/send?room=${this.room}&name=${this.name}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ message, type: "BROADCAST" }),
    }).catch(() => {});
  }
}

// ── Bridge Loop ──────────────────────────────────────────────────────────────

async function runBridge(config: BridgeConfig) {
  const client = new MeshClient(config.api, config.room, config.name, config.agent_token);
  const activeWorkspaces = new Map<string, string>(); // wsPath -> taskId

  console.log(`  Connected to ${config.room} as ${config.name}`);
  console.log(`  Watching workspaces in: ${config.workspace_root}`);
  console.log(`  Max concurrent: ${config.max_concurrent}`);
  console.log(`  Poll interval: ${config.poll_interval_ms / 1000}s`);
  console.log(`  Press Ctrl+C to stop\n`);

  // Initial heartbeat
  await client.heartbeat();
  await client.sendMessage(`${config.name} bridge connected. Watching for tasks.`);

  async function tick() {
    // 1. Heartbeat
    await client.heartbeat();

    // 2. Discover workspaces
    const workspaces = discoverWorkspaces(config.workspace_root);

    // 3. Check for completed/blocked tasks
    for (const [wsPath, taskId] of activeWorkspaces) {
      const status = getWorkspaceStatus(wsPath);
      if (status === "complete") {
        const completion = readTaskComplete(wsPath);
        if (completion) {
          const isBlocked = (completion as any).blocked === true;
          if (isBlocked) {
            const blocker = (completion as any).blocker || "unknown reason";
            console.log(`  [blocked] ${taskId} in ${basename(wsPath)}: ${blocker}`);
            // Release back to queue so someone else can try or humans can unblock
            await client.releaseTask(taskId);
            await client.sendMessage(`Task ${taskId} blocked: ${blocker} — released back to queue. Needs human input.`);
          } else {
            console.log(`  [done] ${taskId} in ${basename(wsPath)}: ${completion.summary || "completed"}`);
            await client.updateTask(taskId, {
              status: "done",
              pr_url: completion.pr_url,
              branch_name: completion.branch_name,
            });
            const prInfo = completion.pr_url ? ` — PR: ${completion.pr_url}` : "";
            await client.sendMessage(`Task ${taskId} completed by ${basename(wsPath)}${prInfo}`);
          }
        }
        cleanupWorkspaceTask(wsPath);
        activeWorkspaces.delete(wsPath);
      }
    }

    // 4. Find idle workspaces
    const idleWorkspaces = workspaces.filter(
      (ws) => !activeWorkspaces.has(ws) && getWorkspaceStatus(ws) === "idle"
    );

    if (idleWorkspaces.length === 0 || activeWorkspaces.size >= config.max_concurrent) {
      return;
    }

    // 5. Get open tasks and claim for idle workspaces
    const openTasks = await client.getOpenTasks();
    if (openTasks.length === 0) return;

    for (const ws of idleWorkspaces) {
      if (activeWorkspaces.size >= config.max_concurrent) break;
      const task = openTasks.shift();
      if (!task) break;

      const claimed = await client.claimTask(task.task_id);
      if (!claimed) continue;

      console.log(`  [claim] ${task.task_id} -> ${basename(ws)}: ${task.title}`);
      assignTaskToWorkspace(ws, task, config);
      activeWorkspaces.set(ws, task.task_id);

      await client.updateTask(task.task_id, { status: "in_progress", branch_name: `mesh/${task.task_id}` });
      await client.sendMessage(`Claimed task ${task.task_id}: "${task.title}" — assigning to workspace ${basename(ws)}`);
    }
  }

  // Run the loop
  while (true) {
    try {
      await tick();
    } catch (e: any) {
      console.error(`  [error] ${e.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.poll_interval_ms));
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cliArgs = parseArgs();
  let config = loadConfig();

  // Merge CLI args over saved config
  if (config && (cliArgs.room || cliArgs.name || cliArgs.api)) {
    config = { ...config, ...cliArgs } as BridgeConfig;
  } else if (!config) {
    // No saved config — run interactive setup
    config = await interactiveSetup();
  }

  // Apply any remaining CLI overrides
  if (cliArgs.max_concurrent) config.max_concurrent = cliArgs.max_concurrent;
  if (cliArgs.poll_interval_ms) config.poll_interval_ms = cliArgs.poll_interval_ms;
  if (cliArgs.workspace_root) config.workspace_root = cliArgs.workspace_root;

  // Validate
  if (!config.room) {
    console.error("  Error: room is required. Run without args for interactive setup, or use --room <code>");
    process.exit(1);
  }

  await runBridge(config);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
