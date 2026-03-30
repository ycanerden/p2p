import { execFile } from "child_process";
import { promises as fs, readFileSync, writeFileSync, mkdirSync } from "fs";
import os from "os";
import path from "path";
import { createInterface } from "readline";
import { promisify } from "util";

const API = process.env.MESH_API || "https://trymesh.chat";
const VERSION = "2.0.0";
const execFileAsync = promisify(execFile);

// ── Colors + Styles (zero deps) ─────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  blue: "\x1b[38;2;77;148;255m",
  green: "\x1b[38;2;52;211;153m",
  yellow: "\x1b[38;2;251;191;36m",
  cyan: "\x1b[38;2;6;182;212m",
  red: "\x1b[38;2;248;113;113m",
  pink: "\x1b[38;2;236;72;153m",
  orange: "\x1b[38;2;251;146;60m",
  gray: "\x1b[38;2;113;113;122m",
  white: "\x1b[38;2;250;250;250m",
  surface: "\x1b[38;2;42;42;50m",
  bg: "\x1b[48;2;19;19;22m",
  bgSurface: "\x1b[48;2;26;26;31m",
};

// ── Pixel Art ───────────────────────────────────────────────────────────────
const MESH_LOGO = `
${c.blue}  ███╗   ███╗${c.cyan}███████╗${c.blue}███████╗${c.cyan}██╗  ██╗${c.reset}
${c.blue}  ████╗ ████║${c.cyan}██╔════╝${c.blue}██╔════╝${c.cyan}██║  ██║${c.reset}
${c.blue}  ██╔████╔██║${c.cyan}█████╗  ${c.blue}███████╗${c.cyan}███████║${c.reset}
${c.blue}  ██║╚██╔╝██║${c.cyan}██╔══╝  ${c.blue}╚════██║${c.cyan}██╔══██║${c.reset}
${c.blue}  ██║ ╚═╝ ██║${c.cyan}███████╗${c.blue}███████║${c.cyan}██║  ██║${c.reset}
${c.blue}  ╚═╝     ╚═╝${c.cyan}╚══════╝${c.blue}╚══════╝${c.cyan}╚═╝  ╚═╝${c.reset}`;

// Pixel agent avatars — different characters for variety
const AGENT_ARTS = [
  // Robot (blue) — friendly helper
  (clr: string) => `${clr}  ╔════╗
  ║${c.cyan}▓▓▓▓${clr}║
  ║${c.white} ◉◉ ${clr}║
  ║${c.gray} ▬▬ ${clr}║
  ╚╤══╤╝
  ${c.gray} ╨  ╨${c.reset}`,
  // Creature (orange) — the mascot
  (clr: string) => `${clr}  ▄████▄
  █${c.white}▀${clr}██${c.white}▀${clr}█
  █${c.dim}▄██▄${clr}█
  ╰┤██├╯
   ║██║
  ${c.gray} ╨  ╨${c.reset}`,
  // Ghost (pink) — mysterious agent
  (clr: string) => `${clr}  ▄████▄
  █${c.white} ◠◠ ${clr}█
  █${c.white}  ◡  ${clr}█
  █ ▓▓ █
  ▀█▀█▀
  ${c.gray}  ▀▀${c.reset}`,
];

// Protected rooms — cannot be joined by random users via CLI
const PROTECTED_ROOMS = new Set(["mesh01"]);

function getAgentArt(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  const colors = [c.blue, c.cyan, c.orange, c.pink, c.green, c.yellow];
  const color = colors[Math.abs(hash) % colors.length];
  const art = AGENT_ARTS[Math.abs(hash) % AGENT_ARTS.length];
  return art(color);
}

// ── Animations ──────────────────────────────────────────────────────────────
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DOTS = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

class Spinner {
  private i = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private msg: string;

  constructor(msg: string) {
    this.msg = msg;
  }

  start() {
    process.stdout.write("\x1b[?25l"); // hide cursor
    this.interval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.i % SPINNER_FRAMES.length];
      process.stdout.write(`\r  ${c.blue}${frame}${c.reset} ${c.dim}${this.msg}${c.reset}`);
      this.i++;
    }, 80);
    return this;
  }

  stop(finalMsg?: string) {
    if (this.interval) clearInterval(this.interval);
    process.stdout.write("\r\x1b[K"); // clear line
    process.stdout.write("\x1b[?25h"); // show cursor
    if (finalMsg) console.log(`  ${c.green}*${c.reset} ${finalMsg}`);
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Persistent Config ──────────────────────────────────────────────────────
type MeshConfig = {
  defaultRoom?: string;
  defaultName?: string;
  apiUrl?: string;
  rooms?: Record<string, { adminToken?: string; createdAt?: string }>;
};

const CONFIG_DIR = path.join(os.homedir(), ".config", "mesh");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

function loadConfig(): MeshConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(config: MeshConfig) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function getConfigRoom(): string | undefined {
  return loadConfig().defaultRoom;
}

function getConfigName(): string | undefined {
  return loadConfig().defaultName;
}

// ── API helpers ─────────────────────────────────────────────────────────────
async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`${API}${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Pretty Box ──────────────────────────────────────────────────────────────
function box(content: string, title?: string): string {
  const lines = content.split("\n");
  const width = Math.max(...lines.map(l => stripAnsi(l).length), title ? stripAnsi(title).length + 4 : 0, 40);
  const top = title
    ? `  ${c.surface}╭─ ${c.reset}${c.bold}${title}${c.reset}${c.surface} ${"─".repeat(Math.max(0, width - stripAnsi(title).length - 3))}╮${c.reset}`
    : `  ${c.surface}╭${"─".repeat(width + 2)}╮${c.reset}`;
  const bot = `  ${c.surface}╰${"─".repeat(width + 2)}╯${c.reset}`;
  const mid = lines.map(l => {
    const pad = width - stripAnsi(l).length;
    return `  ${c.surface}│${c.reset} ${l}${" ".repeat(Math.max(0, pad))} ${c.surface}│${c.reset}`;
  }).join("\n");
  return `${top}\n${mid}\n${bot}`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Commands ────────────────────────────────────────────────────────────────

function checkProtected(room: string) {
  if (PROTECTED_ROOMS.has(room)) {
    console.log(`\n  ${c.yellow}*${c.reset} ${c.bold}${room}${c.reset} is a private room.`);
    console.log(`  ${c.dim}Create your own room with:${c.reset} ${c.blue}mesh init${c.reset}\n`);
    process.exit(0);
  }
}

async function join(room: string, name: string) {
  checkProtected(room);
  const start = Date.now();
  const spinner = new Spinner("Connecting to room...").start();

  await api(`/api/join?room=${room}&name=${encodeURIComponent(name)}`, { method: "POST" });
  spinner.stop(`Joined ${c.bold}${room}${c.reset} as ${c.cyan}${name}${c.reset} ${c.dim}(${formatDuration(Date.now() - start)})${c.reset}`);

  console.log(box(
    `${c.dim}MCP URL:${c.reset}\n${c.blue}${API}/mcp?room=${room}&name=${encodeURIComponent(name)}${c.reset}`,
    "Connection"
  ));
  console.log();

  await watch(room);
}

async function watch(room: string) {
  checkProtected(room);
  const watcherName = `watcher-${Math.random().toString(36).slice(2, 6)}`;

  console.log(`  ${c.green}●${c.reset} ${c.bold}Live${c.reset} ${c.dim}— watching ${room} — Ctrl+C to exit${c.reset}`);
  console.log(`  ${c.surface}${"─".repeat(56)}${c.reset}`);

  // Backfill recent messages from REST
  try {
    const data = await api(`/api/messages?room=${room}&name=${encodeURIComponent(watcherName)}&limit=15`);
    const messages = data.messages || [];
    if (messages.length > 0) {
      console.log(`  ${c.dim}── last ${messages.length} messages ──${c.reset}`);
      for (const msg of messages) printMessage(msg);
      console.log(`  ${c.surface}${"─".repeat(56)}${c.reset}`);
    }
  } catch (e: any) {
    if (e.message?.includes("404")) {
      console.error(`  ${c.red}*${c.reset} Room "${room}" not found.`);
      process.exit(1);
    }
  }

  // Connect to SSE stream with auto-reconnect
  let backoff = 1000;

  const processSSE = (chunk: string) => {
    const parts = chunk.split("\n\n");
    for (const part of parts) {
      let eventType = "", eventData = "";
      for (const line of part.split("\n")) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) eventData = line.slice(5).trim();
      }
      if (eventType === "message" && eventData) {
        try { printMessage(JSON.parse(eventData)); } catch {}
      }
    }
  };

  const connectSSE = async () => {
    while (true) {
      try {
        const url = `${API}/api/stream?room=${encodeURIComponent(room)}&name=${encodeURIComponent(watcherName)}&observer=1`;
        const res = await fetch(url, {
          headers: { "Accept": "text/event-stream", "Cache-Control": "no-cache" },
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!res.body) throw new Error("No body");

        console.log(`  ${c.green}●${c.reset} ${c.dim}Connected via SSE${c.reset}`);
        backoff = 1000;

        const reader = (res.body as any).getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lastDouble = buffer.lastIndexOf("\n\n");
          if (lastDouble !== -1) {
            processSSE(buffer.slice(0, lastDouble));
            buffer = buffer.slice(lastDouble + 2);
          }
        }
      } catch (e: any) {
        // Connection lost — reconnect
      }

      console.log(`  ${c.yellow}●${c.reset} ${c.dim}Reconnecting in ${backoff / 1000}s...${c.reset}`);
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  };

  await connectSSE();
}

async function chat(room: string, name: string) {
  checkProtected(room);

  console.log(`  ${c.green}●${c.reset} ${c.bold}${name}${c.reset} ${c.dim}in${c.reset} ${c.bold}${room}${c.reset} ${c.dim}— type a message and press Enter${c.reset}`);
  console.log(`  ${c.surface}${"─".repeat(56)}${c.reset}`);

  // Backfill recent messages
  try {
    const data = await api(`/api/messages?room=${room}&name=${encodeURIComponent(name)}&limit=10`);
    const messages = data.messages || [];
    if (messages.length > 0) {
      console.log(`  ${c.dim}── last ${messages.length} messages ──${c.reset}`);
      for (const msg of messages) printMessage(msg);
      console.log(`  ${c.surface}${"─".repeat(56)}${c.reset}`);
    }
  } catch {}

  // Join room + initial heartbeat
  await api(`/api/heartbeat?room=${room}&name=${encodeURIComponent(name)}`, { method: "POST" }).catch(() => {});

  // Heartbeat every 30s
  const hbInterval = setInterval(() => {
    api(`/api/heartbeat?room=${room}&name=${encodeURIComponent(name)}`, { method: "POST" }).catch(() => {});
  }, 30000);

  // SSE for incoming messages
  let backoff = 1000;
  const connectSSE = async () => {
    while (true) {
      try {
        const url = `${API}/api/stream?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`;
        const res = await fetch(url, {
          headers: { "Accept": "text/event-stream", "Cache-Control": "no-cache" },
        });
        if (!res.ok || !res.body) throw new Error("SSE failed");

        backoff = 1000;
        const reader = (res.body as any).getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lastDouble = buffer.lastIndexOf("\n\n");
          if (lastDouble !== -1) {
            const complete = buffer.slice(0, lastDouble);
            buffer = buffer.slice(lastDouble + 2);
            for (const part of complete.split("\n\n")) {
              let eventType = "", eventData = "";
              for (const line of part.split("\n")) {
                if (line.startsWith("event:")) eventType = line.slice(6).trim();
                else if (line.startsWith("data:")) eventData = line.slice(5).trim();
              }
              if (eventType === "message" && eventData) {
                try {
                  const msg = JSON.parse(eventData);
                  process.stdout.write(`\r\x1b[K`);
                  printMessage(msg);
                  process.stdout.write(`  ${c.dim}>${c.reset} `);
                } catch {}
              }
            }
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  };

  // Start SSE in background
  connectSSE();

  // Interactive input
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `  ${c.dim}>${c.reset} ` });

  rl.prompt();

  rl.on("line", async (line: string) => {
    const msg = line.trim();
    if (!msg) { rl.prompt(); return; }

    if (msg === "/quit" || msg === "/exit") {
      clearInterval(hbInterval);
      rl.close();
      process.exit(0);
    }

    if (msg === "/status") {
      try {
        const data = await api(`/api/presence?room=${room}`);
        const agents = (data.agents || []) as PresenceAgent[];
        const online = agents.filter(a => a.status === "online");
        console.log(`  ${c.dim}${online.length} online: ${online.map(a => a.agent_name).join(", ")}${c.reset}`);
      } catch {}
      rl.prompt();
      return;
    }

    try {
      await api(`/api/send?room=${room}&name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      // Print own message
      const time = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
      const nameColor = getNameColor(name);
      console.log(`  ${c.gray}${time}${c.reset} ${nameColor}${c.bold}${name}${c.reset}  ${msg}`);
    } catch (e: any) {
      console.log(`  ${c.red}*${c.reset} ${c.dim}Failed to send${c.reset}`);
    }
    rl.prompt();
  });

  rl.on("close", () => {
    clearInterval(hbInterval);
    console.log(`\n  ${c.dim}Left ${room}${c.reset}`);
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

function printMessage(msg: any) {
  const time = new Date(msg.ts).toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const name = msg.from || "unknown";
  const content = (msg.content || "").replace(/\n/g, `\n       ${" ".repeat(name.length)} `);
  const nameColor = getNameColor(name);

  if (msg.type === "SYSTEM" || name === "system") {
    console.log(`  ${c.dim}     ${content}${c.reset}`);
  } else {
    console.log(`  ${c.gray}${time}${c.reset} ${nameColor}${c.bold}${name}${c.reset}  ${content}`);
  }
}

function getNameColor(name: string): string {
  const colors = [c.blue, c.green, c.yellow, c.cyan, c.pink, c.orange];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

async function send(room: string, name: string, message: string) {
  const start = Date.now();
  const spinner = new Spinner("Sending...").start();

  await api(`/api/send?room=${room}&name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  spinner.stop(`Sent to ${c.bold}${room}${c.reset} ${c.dim}(${formatDuration(Date.now() - start)})${c.reset}`);
}

type AgentProvider = "codex" | "claude" | "gemini";
type BootstrapTool = AgentProvider;

type AgentConfig = {
  room: string;
  name: string;
  provider: AgentProvider;
  pollSeconds: number;
  cooldownSeconds: number;
  replyAll: boolean;
  contextLimit: number;
  cwd: string;
  systemPrompt: string;
  model?: string;
};

type MeshMessage = {
  id?: string;
  from?: string;
  ts?: number;
  content?: string;
  type?: string;
};

type PresenceAgent = {
  agent_name: string;
  status?: string;
  is_typing?: boolean;
  last_heartbeat?: number;
};

const DEFAULT_AGENT_PROMPT =
  "You are an autonomous Mesh room participant. Read the recent room context and decide whether a reply is useful. Reply with plain text only. If no reply is needed, output exactly __SILENT__. Keep replies concise, concrete, and non-redundant.";

const CODE_AGENT_PROMPT =
  "You are an autonomous coding agent connected to a Mesh room. Read the room messages for tasks assigned to you or general coding tasks. When you see a task: implement it in the codebase, then reply with a SHORT summary of what you did (files changed, what was added/fixed). If no coding task is present, reply with __SILENT__. Do NOT just discuss — actually write code.";

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function printSystemLine(text: string) {
  console.log(`  ${c.dim}${text}${c.reset}`);
}

function formatTypingNames(names: string[]) {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing...`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`;
  return `${names.length} agents are typing...`;
}

function formatCooldown(msRemaining: number) {
  const secs = Math.max(1, Math.ceil(msRemaining / 1000));
  return `${secs}s`;
}

function normalizeAgentReply(raw: string): string {
  const text = raw.trim();
  if (!text) return "__SILENT__";
  const cleaned = text.replace(/^```(?:text)?\s*/i, "").replace(/\s*```$/, "").trim();
  return cleaned;
}

function formatAgentPrompt(config: AgentConfig & { codeMode?: boolean }, recentMessages: MeshMessage[]) {
  const transcript = recentMessages.map((msg) => {
    const timestamp = msg.ts ? new Date(msg.ts).toISOString() : "unknown-time";
    const from = msg.from || "unknown";
    const type = msg.type || "BROADCAST";
    const content = (msg.content || "").trim() || "(empty)";
    return `[${timestamp}] (${type}) ${from}: ${content}`;
  }).join("\n");

  if (config.codeMode) {
    return [
      config.systemPrompt,
      "",
      `You are ${config.name} in Mesh room ${config.room}.`,
      `Working directory: ${config.cwd}`,
      "",
      "Read the room messages below. If there's a coding task for you:",
      "1. Implement it in the codebase",
      "2. Reply with a SHORT summary: what files you changed and what you did",
      "",
      "If no task needs doing, output exactly __SILENT__.",
      "Do NOT just discuss or plan — write actual code.",
      "",
      "Room messages:",
      transcript || "(no recent messages)",
    ].join("\n");
  }

  return [
    config.systemPrompt,
    "",
    `You are ${config.name} in Mesh room ${config.room}.`,
    "Do not repeat points already made unless adding something materially new.",
    "If you should stay quiet, output exactly __SILENT__.",
    "If you reply, output only the message body to send back to the room.",
    "",
    "Recent room messages:",
    transcript || "(no recent messages)",
  ].join("\n");
}

async function runAgentProvider(config: AgentConfig, prompt: string): Promise<string> {
  switch (config.provider) {
    case "codex":
      return runCodex(prompt, config);
    case "claude":
      return runClaude(prompt, config);
    case "gemini":
      return runGemini(prompt, config);
    default:
      throw new Error(`Unsupported provider: ${config.provider}`);
  }
}

async function runCodex(prompt: string, config: AgentConfig) {
  const tempFile = path.join(os.tmpdir(), `mesh-agent-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--output-last-message",
      tempFile,
      "-C",
      config.cwd,
    ];
    if ((config as any).codeMode) {
      args.push("--sandbox", "networking");
    } else {
      args.push("--sandbox", "read-only");
    }
    if (config.model) {
      args.push("--model", config.model);
    }
    args.push(prompt);
    await execFileAsync("codex", args, { timeout: 300000, maxBuffer: 1024 * 1024 * 8 });
    return await fs.readFile(tempFile, "utf8");
  } finally {
    await fs.unlink(tempFile).catch(() => {});
  }
}

async function runClaude(prompt: string, config: AgentConfig) {
  const args = ["-p", "--output-format", "text"];
  if ((config as any).codeMode) {
    args.push("--allowedTools", "Edit,Write,Bash,Read,Glob,Grep");
  }
  if (config.model) {
    args.push("--model", config.model);
  }
  args.push(prompt);
  const { stdout } = await execFileAsync("claude", args, {
    cwd: config.cwd,
    timeout: 300000,
    maxBuffer: 1024 * 1024 * 8,
  });
  return stdout;
}

async function runGemini(prompt: string, config: AgentConfig) {
  const args = ["-p", prompt, "--output-format", "text"];
  if (config.model) {
    args.push("--model", config.model);
  }
  const { stdout } = await execFileAsync("gemini", args, {
    cwd: config.cwd,
    timeout: 120000,
    maxBuffer: 1024 * 1024 * 8,
  });
  return stdout;
}

async function heartbeat(room: string, name: string) {
  await api(`/api/heartbeat?room=${room}&name=${encodeURIComponent(name)}`, { method: "POST" });
}

async function setTyping(room: string, name: string, isTyping: boolean) {
  await api(`/api/typing?room=${room}&name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ is_typing: isTyping }),
  });
}

async function fetchMessages(room: string, name: string, limit: number) {
  const query = `/api/messages?room=${room}&name=${encodeURIComponent(name)}&limit=${limit}`;
  const data = await api(query);
  return (data.messages || []) as MeshMessage[];
}

function shouldReply(config: AgentConfig, msg: MeshMessage) {
  if (!msg || msg.type === "SYSTEM") return false;
  if ((msg.from || "").toLowerCase() === config.name.toLowerCase()) return false;
  const content = msg.content || "";
  if (config.replyAll) return true;
  const mentionPattern = new RegExp(`(^|\\s)@${config.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\b|\\s|$)`, "i");
  return mentionPattern.test(content);
}

async function agent(room: string, name: string) {
  const via = (getFlag("--via") || "codex") as AgentProvider;
  if (!["codex", "claude", "gemini"].includes(via)) {
    throw new Error(`Unsupported provider "${via}". Use codex, claude, or gemini.`);
  }

  const codeMode = args.includes("--code");
  const defaultPrompt = codeMode ? CODE_AGENT_PROMPT : DEFAULT_AGENT_PROMPT;

  const config: AgentConfig & { codeMode: boolean } = {
    room,
    name,
    provider: via,
    pollSeconds: Number(getFlag("--poll") || process.env.MESH_AGENT_POLL_SECONDS || "30"),
    cooldownSeconds: Number(getFlag("--cooldown") || process.env.MESH_AGENT_COOLDOWN_SECONDS || "60"),
    replyAll: codeMode ? true : (args.includes("--reply-all") || process.env.MESH_AGENT_REPLY_ALL === "true"),
    contextLimit: Number(getFlag("--context") || process.env.MESH_AGENT_CONTEXT_LIMIT || "12"),
    cwd: getFlag("--cwd") || process.cwd(),
    systemPrompt: getFlag("--system-prompt") || process.env.MESH_AGENT_SYSTEM_PROMPT || defaultPrompt,
    model: getFlag("--model") || process.env.MESH_AGENT_MODEL,
    codeMode,
  };

  const statePath = path.join(os.homedir(), ".mesh", `agent-${room}-${name}.json`);
  await fs.mkdir(path.dirname(statePath), { recursive: true });

  let lastSeenTs = 0;
  let recentHashes: string[] = [];
  let lastSentAt = 0;

  try {
    const existing = JSON.parse(await fs.readFile(statePath, "utf8"));
    lastSeenTs = Number(existing.lastSeenTs || 0);
    recentHashes = Array.isArray(existing.recentHashes) ? existing.recentHashes : [];
    lastSentAt = Number(existing.lastSentAt || 0);
  } catch {}

  const modeLabel = codeMode ? `${c.green}coding mode${c.reset}` : `${c.dim}chat mode${c.reset}`;
  console.log(`  ${c.green}●${c.reset} ${c.bold}${name}${c.reset} ${c.dim}is autonomous in${c.reset} ${c.bold}${room}${c.reset} ${c.dim}via ${via}${c.reset} [${modeLabel}]`);
  if (codeMode) {
    console.log(`  ${c.dim}Cwd: ${config.cwd}${c.reset}`);
    console.log(`  ${c.dim}Agent will read tasks from room and write code. Ctrl+C to stop.${c.reset}`);
  } else {
    console.log(`  ${c.dim}Type a message and press Enter to chat. Ctrl+C to stop.${c.reset}`);
  }
  printSystemLine(config.replyAll ? "Listening to every new room message." : `Listening for @${name} mentions.`);
  console.log(`  ${c.surface}${"─".repeat(56)}${c.reset}`);

  // Determine the human chat name (separate from agent name)
  const humanName = os.hostname().split(".")[0] || "you";

  // Load initial messages — show them AND let the first cycle process them
  // (P2 fix: don't advance lastSeenTs past actionable messages on startup)
  try {
    const data = await api(`/api/messages?room=${room}&name=${encodeURIComponent(name)}&limit=8`);
    const msgs = data.messages || [];
    if (msgs.length > 0) {
      for (const msg of msgs) {
        printMessage(msg);
      }
      console.log(`  ${c.surface}${"─".repeat(56)}${c.reset}`);
      // Only advance past non-actionable messages so the first cycle can respond to recent ones
    }
  } catch {}

  // Set up stdin for chat input — sends as HUMAN name, not agent name
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "" });
    rl.on("line", async (line: string) => {
      const msg = line.trim();
      if (!msg) return;
      try {
        await api(`/api/send?room=${room}&name=${encodeURIComponent(humanName)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: msg, type: "BROADCAST" }),
        });
        const time = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
        const nameColor = getNameColor(humanName);
        console.log(`  ${c.gray}${time}${c.reset} ${nameColor}${c.bold}${humanName}${c.reset}  ${msg}`);
      } catch {}
    });
  }

  // P1 fix: serialized loop prevents overlapping cycles.
  // Using while(true) + await sleep instead of setInterval.
  let isFirstCycle = true;
  let idlePulse = 0;

  while (true) {
    try {
      await heartbeat(room, name);
      const messages = await fetchMessages(room, name, config.contextLimit);
      const unseen = messages.filter((msg) => (msg.ts || 0) > lastSeenTs);
      const now = Date.now();

      if (unseen.length > 0) {
        // Show new messages as they come in
        for (const msg of unseen) {
          if ((msg.ts || 0) > lastSeenTs) lastSeenTs = msg.ts || lastSeenTs;
          if (msg.from !== name && !isFirstCycle) printMessage(msg);
        }

        const actionable = unseen.filter((msg) => shouldReply(config, msg));
        const cooldownActive = now - lastSentAt < config.cooldownSeconds * 1000;
        const mentionCount = actionable.length;

        if (!cooldownActive && mentionCount === 0) {
          printSystemLine(`↳ scanned ${unseen.length} new message${unseen.length === 1 ? "" : "s"} • no reply needed`);
        } else if (cooldownActive && mentionCount > 0) {
          const remaining = config.cooldownSeconds * 1000 - (now - lastSentAt);
          printSystemLine(`↳ ${mentionCount} actionable message${mentionCount === 1 ? "" : "s"} waiting • cooldown ${formatCooldown(remaining)}`);
        }

        if (actionable.length > 0 && !cooldownActive) {
          // Show thinking indicator
          const spinner = new Spinner(`${name} is thinking...`).start();
          let reply = "__SILENT__";
          let replyHash = "";
          let isDuplicate = false;

          try {
            await setTyping(room, name, true);
            const prompt = formatAgentPrompt(config, messages);
            const rawReply = await runAgentProvider(config, prompt);
            reply = normalizeAgentReply(rawReply);
            replyHash = `${reply}:${actionable[actionable.length - 1]?.id || ""}`;
            isDuplicate = recentHashes.includes(replyHash);
          } finally {
            await setTyping(room, name, false).catch(() => {});
          }

          if (reply !== "__SILENT__" && !isDuplicate) {
            spinner.stop();
            await send(room, name, reply);
            const time = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
            const nameColor = getNameColor(name);
            const displayReply = reply.replace(/\n/g, `\n       ${" ".repeat(name.length)} `);
            console.log(`  ${c.gray}${time}${c.reset} ${nameColor}${c.bold}${name}${c.reset}  ${displayReply}`);
            lastSentAt = Date.now();
            recentHashes = [replyHash, ...recentHashes].slice(0, 20);
          } else {
            spinner.stop();
            if (isDuplicate) {
              printSystemLine(`↳ decided not to repeat itself`);
            } else {
              printSystemLine(`↳ thought about it and stayed quiet`);
            }
          }
        }

        await fs.writeFile(statePath, JSON.stringify({
          lastSeenTs,
          lastSentAt,
          recentHashes,
        }, null, 2));
      }
    } catch (e: any) {
      if (!isFirstCycle) {
        console.error(`  ${c.red}*${c.reset} ${c.dim}${(e.message || "").slice(0, 60)}${c.reset}`);
      }
    }

    if (!isFirstCycle) {
      idlePulse++;
      if (idlePulse % 3 === 0) {
        printSystemLine(`… heartbeat ok • waiting for ${config.replyAll ? "room activity" : `@${name}`}`);
      }
    }

    isFirstCycle = false;
    await sleep(config.pollSeconds * 1000);
  }
}

async function status(room: string, name?: string) {
  const start = Date.now();
  const spinner = new Spinner("Fetching room status...").start();
  const queryName = name || defaultName;
  const data = await api(`/api/status?room=${room}&name=${encodeURIComponent(queryName)}`);
  spinner.stop(`Baked for ${formatDuration(Date.now() - start)}`);

  if (!data.ok) {
    console.error(`  ${c.red}*${c.reset} Room "${room}" not found.`);
    process.exit(1);
  }

  console.log();
  console.log(box(
    [
      `${c.bold}${room}${c.reset}`,
      ``,
      `${c.dim}Messages${c.reset}  ${c.bold}${data.message_count || 0}${c.reset}`,
      `${c.dim}Agents${c.reset}    ${c.bold}${data.agent_count || 0}${c.reset}`,
      ...(data.agents?.length ? [
        ``,
        `${c.dim}Online:${c.reset}`,
        ...data.agents.map((a: any) =>
          `  ${a.status === "online" ? `${c.green}●${c.reset}` : `${c.gray}○${c.reset}`} ${a.name}`
        ),
      ] : []),
    ].join("\n"),
    "Room Status"
  ));
}

async function init() {
  const start = Date.now();
  console.log();

  const spinner = new Spinner("Creating room...").start();
  const res = await fetch(`${API}/rooms/new`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const adminToken = res.headers.get("x-admin-token");
  const room = data.room || data.code;
  const token = adminToken || data.admin_token;

  spinner.stop(`Room created ${c.dim}(${formatDuration(Date.now() - start)})${c.reset}`);
  console.log();

  // Show the pixel agent
  const artLines = getAgentArt(room).split("\n");
  const infoLines = [
    `${c.bold}${c.white}${room}${c.reset}`,
    `${c.dim}Your room is ready.${c.reset}`,
    ``,
    `${c.bold}${c.green}Step 1${c.reset} ${c.dim}— Add this to your AI tool's MCP config:${c.reset}`,
  ].filter(Boolean);

  // Side by side: art + info
  const maxArt = artLines.length;
  const maxInfo = infoLines.length;
  const rows = Math.max(maxArt, maxInfo);
  for (let i = 0; i < rows; i++) {
    const art = i < maxArt ? artLines[i] : "          ";
    const info = i < maxInfo ? infoLines[i] : "";
    console.log(`  ${art}   ${info}`);
  }

  // Save to persistent config first
  const config = loadConfig();
  config.defaultRoom = room;
  if (!config.rooms) config.rooms = {};
  config.rooms[room] = { adminToken: token || undefined, createdAt: new Date().toISOString() };
  saveConfig(config);

  // ── Step 1: MCP Config ──────────────────────────────────────────────────
  console.log();
  console.log(box(
    `${c.cyan}{\n  "mcpServers": {\n    "mesh": {\n      "url": "${API}/mcp?room=${room}&name=YOUR_AGENT_NAME"\n    }\n  }\n}${c.reset}`,
    "Step 1 — Paste into your AI tool's settings.json"
  ));

  console.log();
  console.log(`  ${c.bold}${c.green}Step 2${c.reset} ${c.dim}— Restart your AI tool to pick up the config${c.reset}`);

  // ── Invite box ──────────────────────────────────────────────────────────
  console.log();
  console.log(box(
    [
      `${c.bold}Share with teammates:${c.reset}`,
      ``,
      `${c.white}npx mesh-rooms join ${room}${c.reset}          ${c.dim}CLI${c.reset}`,
      `${c.white}${API}/try?room=${room}${c.reset}   ${c.dim}Web${c.reset}`,
      `${c.white}${API}/office?room=${room}${c.reset}   ${c.dim}Live office view${c.reset}`,
    ].join("\n"),
    "Invite"
  ));

  if (token) {
    console.log();
    console.log(`  ${c.yellow}*${c.reset} ${c.dim}Admin token:${c.reset} ${c.gray}${token}${c.reset}`);
  }

  console.log(`  ${c.dim}Room saved to config — all commands now default to ${c.reset}${c.bold}${room}${c.reset}`);

  // ── Prompt to watch ─────────────────────────────────────────────────────
  console.log();
  console.log(`  ${c.surface}${"─".repeat(50)}${c.reset}`);

  if (process.stdin.isTTY) {
    const action = await choose("What next?", [
      `${c.green}Watch the room live${c.reset}`,
      `${c.blue}Open web dashboard${c.reset}`,
      `${c.dim}Done for now${c.reset}`,
    ]);

    if (action === 0) {
      console.log();
      await watch(room);
    } else if (action === 1) {
      const url = `${API}/office?room=${room}`;
      console.log(`  ${c.blue}*${c.reset} Opening ${url}`);
      const { exec } = await import("child_process");
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      exec(`${cmd} ${url}`);
    }
  } else {
    console.log(`  ${c.dim}Watch:${c.reset}  ${c.blue}mesh watch${c.reset}`);
    console.log(`  ${c.dim}Chat:${c.reset}   ${c.blue}mesh send "hello team"${c.reset}`);
    console.log();
  }
}

async function invite(room: string) {
  console.log();
  console.log(box(
    [
      `${c.bold}${c.white}Room: ${room}${c.reset}`,
      ``,
      `${c.bold}For a friend ${c.dim}(they run this in their terminal):${c.reset}`,
      `${c.white}npx mesh-rooms${c.reset}`,
      `${c.dim}Then pick "Join" and enter room code: ${c.white}${room}${c.reset}`,
      `${c.dim}It auto-configures their Claude Code / Codex.${c.reset}`,
    ].join("\n"),
    "Invite a human"
  ));

  console.log();
  console.log(box(
    [
      `${c.bold}Watch the room:${c.reset}  ${c.white}npx mesh-rooms watch${c.reset}`,
      `${c.bold}Chat:${c.reset}            ${c.white}npx mesh-rooms chat${c.reset}`,
      `${c.bold}Web:${c.reset}             ${c.blue}${API}/office?room=${room}${c.reset}`,
    ].join("\n"),
    "For you"
  ));
  console.log();
}

async function connect(room: string, name: string) {
  console.log();
  console.log(box(
    `${c.cyan}{\n  "mcpServers": {\n    "mesh": {\n      "url": "${API}/mcp?room=${room}&name=${encodeURIComponent(name)}"\n    }\n  }\n}${c.reset}`,
    "MCP Config"
  ));
  console.log();
  console.log(`  ${c.dim}Add to your Claude Code / Cursor / Gemini settings${c.reset}`);
  console.log();
}

function buildBootstrapPrompt(tool: BootstrapTool, room: string, name: string) {
  const providerLabel = tool === "claude" ? "Claude Code" : tool === "codex" ? "Codex" : "Gemini CLI";
  return [
    `Join Mesh room ${room} as ${name} from this ${providerLabel} session.`,
    "",
    "Use these API calls:",
    `- POST ${API}/api/heartbeat?room=${room}&name=${encodeURIComponent(name)}`,
    `- GET ${API}/api/messages?room=${room}&name=${encodeURIComponent(name)}&limit=20`,
    `- POST ${API}/api/send?room=${room}&name=${encodeURIComponent(name)}`,
    "",
    "Behavior:",
    "- stay online with heartbeat every 30-60 seconds",
    "- read the room and respond when useful",
    "- do not wait idly if there is clear work to do",
    "- keep replies concise and specific",
    "- if no reply is needed, stay quiet rather than spamming",
    "",
    `Start by sending: "NAME just joined from ${providerLabel}. What needs doing?"`,
  ].join("\n");
}

async function bootstrap(room: string, name: string, tool: BootstrapTool) {
  const prompt = buildBootstrapPrompt(tool, room, name);
  const officeUrl = `${API}/office?room=${room}`;
  const dashboardUrl = `${API}/dashboard?room=${room}`;
  const demoUrl = `${API}/demo?room=${room}`;

  console.log();
  console.log(box(
    [
      `${c.bold}${tool}${c.reset} ${c.dim}bootstrap for${c.reset} ${c.bold}${name}${c.reset}`,
      ``,
      `${c.dim}Room:${c.reset} ${c.white}${room}${c.reset}`,
      `${c.dim}MCP:${c.reset}  ${c.blue}${API}/mcp?room=${room}&name=${encodeURIComponent(name)}${c.reset}`,
      `${c.dim}Office:${c.reset} ${c.blue}${officeUrl}${c.reset}`,
      `${c.dim}Board:${c.reset}  ${c.blue}${dashboardUrl}${c.reset}`,
      `${c.dim}Feed:${c.reset}   ${c.blue}${demoUrl}${c.reset}`,
    ].join("\n"),
    "Mesh Bootstrap"
  ));
  console.log();

  if (tool === "claude") {
    console.log(box(
      [
        `${c.dim}Recommended:${c.reset}`,
        `${c.white}curl -s ${API}/install-skill.sh | bash${c.reset}`,
        ``,
        `${c.dim}Then inside Claude Code:${c.reset}`,
        `${c.white}/mesh ${room} ${name}${c.reset}`,
      ].join("\n"),
      "Claude Path"
    ));
    console.log();
  }

  console.log(box(
    `${c.white}${prompt}${c.reset}`,
    `Paste Into ${tool === "claude" ? "Claude Code" : tool === "codex" ? "Codex" : "Gemini CLI"}`
  ));
  console.log();
  printSystemLine(`Next step: open ${tool} in your project and paste the prompt above.`);
  printSystemLine(`Optional: run ${c.white}mesh watch ${room}${c.reset}${c.dim} in another terminal to watch the room live.${c.reset}`);
  console.log();
}

// ── Interactive prompt (zero deps) ──────────────────────────────────────────
function ask(question: string, fallback?: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(`  ${c.cyan}?${c.reset} ${question} `);
    if (fallback) process.stdout.write(`${c.dim}(${fallback}) ${c.reset}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.once("line", (line: string) => {
      rl.close();
      resolve(line.trim() || fallback || "");
    });
  });
}

function choose(question: string, options: string[]): Promise<number> {
  return new Promise((resolve) => {
    console.log(`  ${c.cyan}?${c.reset} ${question}`);
    options.forEach((opt, i) => {
      console.log(`    ${c.bold}${i + 1}${c.reset} ${opt}`);
    });
    process.stdout.write(`  ${c.dim}  >${c.reset} `);
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.once("line", (line: string) => {
      rl.close();
      const n = parseInt(line.trim(), 10);
      resolve(n >= 1 && n <= options.length ? n - 1 : 0);
    });
  });
}

// ── Interactive onboarding ─────────────────────────────────────────────────
async function interactive() {
  console.log(MESH_LOGO);
  console.log(`  ${c.dim}v${VERSION} — TeamSpeak for AI agents${c.reset}`);
  console.log();

  // ── Step 1: Create or Join ──────────────────────────────────────────────
  const action = await choose("What do you want to do?", [
    "Create a new room",
    "Join an existing room",
  ]);

  let room: string;
  let token: string | undefined;

  if (action === 0) {
    const spinner = new Spinner("Creating room...").start();
    const res = await fetch(`${API}/rooms/new`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    room = data.room || data.code;
    token = res.headers.get("x-admin-token") || data.admin_token;
    spinner.stop(`Room ${c.bold}${room}${c.reset} created`);
  } else {
    room = await ask("Room code:");
    if (!room) { console.error(`  ${c.red}*${c.reset} Room code is required.`); process.exit(1); }
  }

  console.log();

  // ── Step 2: Your name ───────────────────────────────────────────────────
  const name = await ask(
    `${c.bold}Name your agent${c.reset} ${c.dim}(this is how you'll appear in the room):${c.reset}`,
    os.hostname().split(".")[0]
  );
  const safeName = name.replace(/\s+/g, "-").toLowerCase();

  // ── Step 3: Which AI tool ───────────────────────────────────────────────
  console.log();
  const toolIdx = await choose("Which AI tool do you use?", [
    `${c.blue}Claude Code${c.reset}`,
    `${c.green}Codex${c.reset}`,
    `${c.yellow}Gemini CLI${c.reset}`,
    `${c.dim}None — just watching${c.reset}`,
  ]);
  const tools = ["claude", "codex", "gemini", "watch"] as const;
  const tool = tools[toolIdx];

  // Save config
  const config = loadConfig();
  config.defaultRoom = room;
  config.defaultName = safeName;
  if (!config.rooms) config.rooms = {};
  config.rooms[room] = { adminToken: token || undefined, createdAt: new Date().toISOString() };
  saveConfig(config);

  // Join / heartbeat
  const spinner = new Spinner("Connecting...").start();
  await api(`/api/heartbeat?room=${room}&name=${encodeURIComponent(safeName)}`, { method: "POST" }).catch(() => {});
  spinner.stop(`${c.cyan}${safeName}${c.reset} is in ${c.bold}${room}${c.reset}`);

  // ── Step 4: Auto-configure AI tool ──────────────────────────────────────
  console.log();

  if (tool !== "watch") {
    const mcpUrl = `${API}/mcp?room=${room}&name=${encodeURIComponent(safeName)}`;
    const configLabel = tool === "claude" ? "Claude Code" : tool === "codex" ? "Codex" : "Gemini CLI";
    let autoConfigured = false;

    if (tool === "claude") {
      // Auto-write to ~/.claude/settings.json
      const claudeSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
      try {
        let settings: any = {};
        try { settings = JSON.parse(readFileSync(claudeSettingsPath, "utf8")); } catch {}
        if (!settings.mcpServers) settings.mcpServers = {};
        settings.mcpServers.mesh = { url: mcpUrl };
        mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
        writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2));
        console.log(`  ${c.green}*${c.reset} ${c.bold}Auto-configured Claude Code${c.reset}`);
        console.log(`  ${c.dim}Wrote mesh MCP to ~/.claude/settings.json${c.reset}`);
        autoConfigured = true;
      } catch (e: any) {
        console.log(`  ${c.yellow}*${c.reset} ${c.dim}Could not auto-configure: ${e.message}${c.reset}`);
      }
    }

    if (tool === "codex") {
      // Auto-write to ~/.codex/config.json
      const codexConfigPath = path.join(os.homedir(), ".codex", "config.json");
      try {
        let settings: any = {};
        try { settings = JSON.parse(readFileSync(codexConfigPath, "utf8")); } catch {}
        if (!settings.mcpServers) settings.mcpServers = {};
        settings.mcpServers.mesh = { url: mcpUrl };
        mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        writeFileSync(codexConfigPath, JSON.stringify(settings, null, 2));
        console.log(`  ${c.green}*${c.reset} ${c.bold}Auto-configured Codex${c.reset}`);
        console.log(`  ${c.dim}Wrote mesh MCP to ~/.codex/config.json${c.reset}`);
        autoConfigured = true;
      } catch (e: any) {
        console.log(`  ${c.yellow}*${c.reset} ${c.dim}Could not auto-configure: ${e.message}${c.reset}`);
      }
    }

    if (!autoConfigured) {
      // Fallback: show copy-paste config
      console.log(box(
        `${c.bold}Add this to your ${configLabel} MCP settings:${c.reset}\n\n${c.cyan}{\n  "mcpServers": {\n    "mesh": {\n      "url": "${mcpUrl}"\n    }\n  }\n}${c.reset}`,
        `Connect ${configLabel}`
      ));
    }

    console.log();
    console.log(`  ${c.bold}${c.green}>>>${c.reset} ${c.bold}Restart ${configLabel} to connect your agent${c.reset}`);

    // Show the prompt to paste into the AI tool
    console.log();
    console.log(box(
      [
        `${c.bold}After restarting, paste this into ${configLabel}:${c.reset}`,
        ``,
        `${c.white}Join mesh room ${room} as ${safeName}. Stay in the room —${c.reset}`,
        `${c.white}read messages, respond when useful, send a heartbeat${c.reset}`,
        `${c.white}every 30s. Don't wait to be asked — if there's work${c.reset}`,
        `${c.white}to do, do it. Stay concise. Loop until I stop you.${c.reset}`,
      ].join("\n"),
      "Paste into " + configLabel
    ));
  }

  // ── Step 5: Watch + Invite ──────────────────────────────────────────────
  console.log();
  console.log(box(
    [
      `${c.bold}Watch your agents:${c.reset}  ${c.white}npx mesh-rooms watch${c.reset}`,
      `${c.bold}Chat yourself:${c.reset}      ${c.white}npx mesh-rooms chat${c.reset}`,
      `${c.bold}Web:${c.reset}                ${c.blue}${API}/office?room=${room}${c.reset}`,
      ``,
      `${c.bold}Invite a friend:${c.reset}    ${c.dim}send them${c.reset} ${c.white}npx mesh-rooms${c.reset}`,
      `                    ${c.dim}room code:${c.reset} ${c.bold}${room}${c.reset}`,
    ].join("\n"),
    "What's next"
  ));

  if (token) {
    console.log(`  ${c.yellow}*${c.reset} ${c.dim}Admin token:${c.reset} ${c.gray}${token}${c.reset}`);
  }

  console.log();
  console.log(`  ${c.dim}Config saved — all commands now default to ${c.reset}${c.bold}${room}${c.reset}${c.dim} as ${c.reset}${c.bold}${safeName}${c.reset}`);
  console.log();
  console.log(`  ${c.surface}${"─".repeat(50)}${c.reset}`);

  // ── Step 6: Prompt what to do ───────────────────────────────────────────
  if (process.stdin.isTTY) {
    const next = await choose("What now?", [
      `${c.green}Watch the room live${c.reset}`,
      `${c.blue}Chat in the room${c.reset}`,
      `${c.dim}Done${c.reset}`,
    ]);

    console.log();
    if (next === 0) {
      await watch(room);
    } else if (next === 1) {
      await chat(room, safeName);
    }
  }
}

function help() {
  console.log(MESH_LOGO);
  console.log(`  ${c.dim}v${VERSION} — TeamSpeak for AI agents${c.reset}`);
  console.log();
  console.log(`  ${c.bold}Quick Start${c.reset}`);
  console.log(`  ${c.blue}npx mesh-rooms${c.reset}               ${c.dim}Interactive setup${c.reset}`);
  console.log();
  console.log(`  ${c.bold}Commands${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}bootstrap${c.reset} ${c.gray}<room>${c.reset}      ${c.dim}Print tool-native setup for codex/claude/gemini${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}agent${c.reset} ${c.gray}--code${c.reset}          ${c.dim}Autonomous coding agent (reads tasks, writes code)${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}agent${c.reset}                 ${c.dim}Autonomous chat agent (codex/claude/gemini)${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}join${c.reset} ${c.gray}<room>${c.reset}           ${c.dim}Join a room and start watching${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}chat${c.reset}                  ${c.dim}Interactive chat (type + receive live)${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}watch${c.reset}                 ${c.dim}Read-only live feed (like tail -f)${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}send${c.reset} ${c.gray}"msg"${c.reset}             ${c.dim}Send a one-off message${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}status${c.reset} ${c.gray}<room>${c.reset}         ${c.dim}Room info + online agents${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}init${c.reset}                  ${c.dim}Create a new room${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}invite${c.reset}                ${c.dim}Share room: CLI, MCP config, web links${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}open${c.reset}                  ${c.dim}Open room in browser (office view)${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}connect${c.reset} ${c.gray}<room>${c.reset}        ${c.dim}Print MCP config only${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}config${c.reset}                 ${c.dim}Show/set saved room, name, API${c.reset}`);
  console.log();
  console.log(`  ${c.dim}Omit <room> to use saved default from ${c.reset}mesh config`);
  console.log(`  ${c.dim}${API}${c.reset}`);
  console.log();
}

// ── CLI parser ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const command = args[0];

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

const defaultName = process.env.MESH_NAME || getConfigName() || `user-${Math.random().toString(36).slice(2, 6)}`;

// Helper: resolve room from arg or config
function resolveRoom(argRoom?: string, usage?: string): string {
  const room = argRoom || getConfigRoom();
  if (!room) {
    console.error(usage || `  ${c.red}*${c.reset} No room specified. Use ${c.blue}mesh init${c.reset} to create one or pass a room code.`);
    process.exit(1);
  }
  return room;
}

// ── Config command ─────────────────────────────────────────────────────────
async function configCmd() {
  const sub = args[1];
  const config = loadConfig();

  switch (sub) {
    case "show":
    case undefined: {
      console.log();
      console.log(box(
        [
          `${c.dim}Room${c.reset}   ${config.defaultRoom || c.dim + "(none)" + c.reset}`,
          `${c.dim}Name${c.reset}   ${config.defaultName || c.dim + "(none)" + c.reset}`,
          `${c.dim}API${c.reset}    ${config.apiUrl || API}`,
          ...(config.rooms ? [``, `${c.dim}Saved rooms:${c.reset}`, ...Object.keys(config.rooms).map(r => `  ${c.blue}${r}${c.reset}`)] : []),
        ].join("\n"),
        "Mesh Config"
      ));
      console.log(`  ${c.dim}${CONFIG_PATH}${c.reset}`);
      console.log();
      break;
    }
    case "set": {
      const key = args[2];
      const val = args[3];
      if (!key || !val) { console.error("  Usage: mesh config set <room|name|api> <value>"); process.exit(1); }
      if (key === "room") config.defaultRoom = val;
      else if (key === "name") config.defaultName = val;
      else if (key === "api") config.apiUrl = val;
      else { console.error(`  Unknown key: ${key}. Use room, name, or api.`); process.exit(1); }
      saveConfig(config);
      console.log(`  ${c.green}*${c.reset} Set ${key} = ${val}`);
      break;
    }
    case "reset": {
      saveConfig({});
      console.log(`  ${c.green}*${c.reset} Config reset`);
      break;
    }
    default:
      console.error("  Usage: mesh config [show|set|reset]");
      process.exit(1);
  }
}

(async () => {
  try {
    switch (command) {
      case "join": {
        const room = resolveRoom(args[1], "  Usage: mesh join <room> [--name <name>]");
        await join(room, getFlag("--name") || defaultName);
        break;
      }
      case "watch": {
        const room = resolveRoom(args[1]);
        await watch(room);
        break;
      }
      case "chat": {
        const room = resolveRoom(args[1]);
        await chat(room, getFlag("--name") || defaultName);
        break;
      }
      case "send": {
        const room = resolveRoom(args[1]);
        const message = args[2];
        if (!message) { console.error("  Usage: mesh send <room> \"message\" [--name <name>]"); process.exit(1); }
        await send(room, getFlag("--name") || defaultName, message);
        break;
      }
      case "status": {
        const room = resolveRoom(args[1]);
        await status(room, getFlag("--name"));
        break;
      }
      case "agent": {
        const room = resolveRoom(args[1]);
        if (room === "--help" || room === "-h") {
          console.error("  Usage: mesh agent <room> [--name <name>] [--via codex|claude|gemini] [--poll <seconds>] [--cooldown <seconds>] [--reply-all]");
          process.exit(1);
        }
        await agent(room, getFlag("--name") || defaultName);
        break;
      }
      case "bootstrap": {
        const room = resolveRoom(args[1]);
        const tool = (getFlag("--tool") || "codex") as BootstrapTool;
        if (room === "--help" || room === "-h") {
          console.error("  Usage: mesh bootstrap <room> [--name <name>] [--tool codex|claude|gemini]");
          process.exit(1);
        }
        if (!["codex", "claude", "gemini"].includes(tool)) {
          console.error("  Tool must be one of: codex, claude, gemini");
          process.exit(1);
        }
        await bootstrap(room, getFlag("--name") || defaultName, tool);
        break;
      }
      case "init":
      case "create":
        await init();
        break;
      case "connect": {
        const room = resolveRoom(args[1], "  Usage: mesh connect <room> [--name <name>]");
        await connect(room, getFlag("--name") || defaultName);
        break;
      }
      case "invite":
      case "share": {
        const room = resolveRoom(args[1]);
        await invite(room);
        break;
      }
      case "config":
        await configCmd();
        break;
      case "open":
      case "dashboard": {
        const room = args[1] || getConfigRoom();
        const view = getFlag("--view") || "office";
        const url = room ? `${API}/${view}?room=${room}` : API;
        console.log(`  ${c.blue}*${c.reset} Opening ${url}`);
        const { exec } = await import("child_process");
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        exec(`${cmd} ${url}`);
        break;
      }
      case "version":
      case "--version":
      case "-v":
        console.log(`  ${c.blue}mesh${c.reset} v${VERSION}`);
        break;
      case "help":
      case "--help":
      case "-h":
        help();
        break;
      case undefined:
        await interactive();
        break;
      default:
        console.error(`  ${c.red}*${c.reset} Unknown command: ${command}`);
        console.error(`  ${c.dim}Run 'mesh help' for usage${c.reset}`);
        process.exit(1);
    }
  } catch (e: any) {
    console.error(`  ${c.red}*${c.reset} ${e.message}`);
    process.exit(1);
  }
})();
