#!/usr/bin/env node
import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/mesh.ts
var API = process.env.MESH_API || "https://trymesh.chat";
var VERSION = "0.3.0";
var c = {
  reset: "\x1B[0m",
  bold: "\x1B[1m",
  dim: "\x1B[2m",
  italic: "\x1B[3m",
  underline: "\x1B[4m",
  blue: "\x1B[38;2;77;148;255m",
  green: "\x1B[38;2;52;211;153m",
  yellow: "\x1B[38;2;251;191;36m",
  cyan: "\x1B[38;2;6;182;212m",
  red: "\x1B[38;2;248;113;113m",
  pink: "\x1B[38;2;236;72;153m",
  orange: "\x1B[38;2;251;146;60m",
  gray: "\x1B[38;2;113;113;122m",
  white: "\x1B[38;2;250;250;250m",
  surface: "\x1B[38;2;42;42;50m",
  bg: "\x1B[48;2;19;19;22m",
  bgSurface: "\x1B[48;2;26;26;31m"
};
var MESH_LOGO = `
${c.blue}  ███╗   ███╗${c.cyan}███████╗${c.blue}███████╗${c.cyan}██╗  ██╗${c.reset}
${c.blue}  ████╗ ████║${c.cyan}██╔════╝${c.blue}██╔════╝${c.cyan}██║  ██║${c.reset}
${c.blue}  ██╔████╔██║${c.cyan}█████╗  ${c.blue}███████╗${c.cyan}███████║${c.reset}
${c.blue}  ██║╚██╔╝██║${c.cyan}██╔══╝  ${c.blue}╚════██║${c.cyan}██╔══██║${c.reset}
${c.blue}  ██║ ╚═╝ ██║${c.cyan}███████╗${c.blue}███████║${c.cyan}██║  ██║${c.reset}
${c.blue}  ╚═╝     ╚═╝${c.cyan}╚══════╝${c.blue}╚══════╝${c.cyan}╚═╝  ╚═╝${c.reset}`;
var AGENT_ARTS = [
  (clr) => `${clr}  ╔════╗
  ║${c.cyan}▓▓▓▓${clr}║
  ║${c.white} ◉◉ ${clr}║
  ║${c.gray} ▬▬ ${clr}║
  ╚╤══╤╝
  ${c.gray} ╨  ╨${c.reset}`,
  (clr) => `${clr}  ▄████▄
  █${c.white}▀${clr}██${c.white}▀${clr}█
  █${c.dim}▄██▄${clr}█
  ╰┤██├╯
   ║██║
  ${c.gray} ╨  ╨${c.reset}`,
  (clr) => `${clr}  ▄████▄
  █${c.white} ◠◠ ${clr}█
  █${c.white}  ◡  ${clr}█
  █ ▓▓ █
  ▀█▀█▀
  ${c.gray}  ▀▀${c.reset}`
];
var PROTECTED_ROOMS = new Set(["mesh01"]);
function getAgentArt(seed) {
  let hash = 0;
  for (let i = 0;i < seed.length; i++)
    hash = hash * 31 + seed.charCodeAt(i) | 0;
  const colors = [c.blue, c.cyan, c.orange, c.pink, c.green, c.yellow];
  const color = colors[Math.abs(hash) % colors.length];
  const art = AGENT_ARTS[Math.abs(hash) % AGENT_ARTS.length];
  return art(color);
}
var SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
class Spinner {
  i = 0;
  interval = null;
  msg;
  constructor(msg) {
    this.msg = msg;
  }
  start() {
    process.stdout.write("\x1B[?25l");
    this.interval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.i % SPINNER_FRAMES.length];
      process.stdout.write(`\r  ${c.blue}${frame}${c.reset} ${c.dim}${this.msg}${c.reset}`);
      this.i++;
    }, 80);
    return this;
  }
  stop(finalMsg) {
    if (this.interval)
      clearInterval(this.interval);
    process.stdout.write("\r\x1B[K");
    process.stdout.write("\x1B[?25h");
    if (finalMsg)
      console.log(`  ${c.green}*${c.reset} ${finalMsg}`);
  }
}
function formatDuration(ms) {
  if (ms < 1000)
    return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
async function api(path, opts) {
  const res = await fetch(`${API}${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}
function box(content, title) {
  const lines = content.split(`
`);
  const width = Math.max(...lines.map((l) => stripAnsi(l).length), title ? stripAnsi(title).length + 4 : 0, 40);
  const top = title ? `  ${c.surface}╭─ ${c.reset}${c.bold}${title}${c.reset}${c.surface} ${"─".repeat(Math.max(0, width - stripAnsi(title).length - 3))}╮${c.reset}` : `  ${c.surface}╭${"─".repeat(width + 2)}╮${c.reset}`;
  const bot = `  ${c.surface}╰${"─".repeat(width + 2)}╯${c.reset}`;
  const mid = lines.map((l) => {
    const pad = width - stripAnsi(l).length;
    return `  ${c.surface}│${c.reset} ${l}${" ".repeat(Math.max(0, pad))} ${c.surface}│${c.reset}`;
  }).join(`
`);
  return `${top}
${mid}
${bot}`;
}
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
function checkProtected(room) {
  if (PROTECTED_ROOMS.has(room)) {
    console.log(`
  ${c.yellow}*${c.reset} ${c.bold}${room}${c.reset} is a private room.`);
    console.log(`  ${c.dim}Create your own room with:${c.reset} ${c.blue}mesh init${c.reset}
`);
    process.exit(0);
  }
}
async function join(room, name) {
  checkProtected(room);
  const start = Date.now();
  const spinner = new Spinner("Connecting to room...").start();
  await api(`/api/join?room=${room}&name=${encodeURIComponent(name)}`, { method: "POST" });
  spinner.stop(`Joined ${c.bold}${room}${c.reset} as ${c.cyan}${name}${c.reset} ${c.dim}(${formatDuration(Date.now() - start)})${c.reset}`);
  console.log(box(`${c.dim}MCP URL:${c.reset}
${c.blue}${API}/mcp?room=${room}&name=${encodeURIComponent(name)}${c.reset}`, "Connection"));
  console.log();
  await watch(room);
}
async function watch(room) {
  checkProtected(room);
  console.log(`  ${c.green}●${c.reset} ${c.bold}Live${c.reset} ${c.dim}— watching ${room} — Ctrl+C to exit${c.reset}`);
  console.log(`  ${c.surface}${"─".repeat(56)}${c.reset}`);
  let lastTs = 0;
  try {
    const data = await api(`/api/messages?room=${room}&limit=15`);
    const messages = data.messages || [];
    if (messages.length > 0) {
      console.log(`  ${c.dim}── last ${messages.length} messages ──${c.reset}`);
      for (const msg of messages) {
        if (msg.ts > lastTs)
          lastTs = msg.ts;
        printMessage(msg);
      }
      console.log(`  ${c.surface}${"─".repeat(56)}${c.reset}`);
      console.log(`  ${c.green}●${c.reset} ${c.dim}Everything is live${c.reset}`);
    }
  } catch (e) {
    if (e.message?.includes("404")) {
      console.error(`  ${c.red}*${c.reset} Room "${room}" not found.`);
      process.exit(1);
    }
  }
  const poll = async () => {
    try {
      const data = await api(`/api/messages?room=${room}&since=${lastTs}`);
      const messages = data.messages || [];
      for (const msg of messages) {
        if (msg.ts > lastTs)
          lastTs = msg.ts;
        printMessage(msg);
      }
    } catch {}
  };
  setInterval(poll, 2000);
  await new Promise(() => {});
}
function printMessage(msg) {
  const time = new Date(msg.ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const name = msg.from || "unknown";
  const content = (msg.content || "").replace(/\n/g, `
       ${" ".repeat(name.length)} `);
  const nameColor = getNameColor(name);
  if (msg.type === "SYSTEM" || name === "system") {
    console.log(`  ${c.dim}     ${content}${c.reset}`);
  } else {
    console.log(`  ${c.gray}${time}${c.reset} ${nameColor}${c.bold}${name}${c.reset}  ${content}`);
  }
}
function getNameColor(name) {
  const colors = [c.blue, c.green, c.yellow, c.cyan, c.pink, c.orange];
  let hash = 0;
  for (let i = 0;i < name.length; i++)
    hash = hash * 31 + name.charCodeAt(i) | 0;
  return colors[Math.abs(hash) % colors.length];
}
async function send(room, name, message) {
  checkProtected(room);
  const start = Date.now();
  const spinner = new Spinner("Sending...").start();
  await api(`/api/send?room=${room}&name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message })
  });
  spinner.stop(`Sent to ${c.bold}${room}${c.reset} ${c.dim}(${formatDuration(Date.now() - start)})${c.reset}`);
}
async function status(room, name) {
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
  console.log(box([
    `${c.bold}${room}${c.reset}`,
    ``,
    `${c.dim}Messages${c.reset}  ${c.bold}${data.message_count || 0}${c.reset}`,
    `${c.dim}Agents${c.reset}    ${c.bold}${data.agent_count || 0}${c.reset}`,
    ...data.agents?.length ? [
      ``,
      `${c.dim}Online:${c.reset}`,
      ...data.agents.map((a) => `  ${a.status === "online" ? `${c.green}●${c.reset}` : `${c.gray}○${c.reset}`} ${a.name}`)
    ] : []
  ].join(`
`), "Room Status"));
}
async function init() {
  const start = Date.now();
  console.log();
  const spinner = new Spinner("Creating room...").start();
  const res = await fetch(`${API}/rooms/new`);
  if (!res.ok)
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const adminToken = res.headers.get("x-admin-token");
  const room = data.room || data.code;
  const token = adminToken || data.admin_token;
  spinner.stop(`Room created ${c.dim}(${formatDuration(Date.now() - start)})${c.reset}`);
  console.log();
  const artLines = getAgentArt(room).split(`
`);
  const infoLines = [
    `${c.bold}${c.white}${room}${c.reset}`,
    `${c.dim}Your room is ready.${c.reset}`,
    ``,
    `${c.bold}${c.green}Step 1${c.reset} ${c.dim}— Add this to your AI tool's MCP config:${c.reset}`
  ].filter(Boolean);
  const maxArt = artLines.length;
  const maxInfo = infoLines.length;
  const rows = Math.max(maxArt, maxInfo);
  for (let i = 0;i < rows; i++) {
    const art = i < maxArt ? artLines[i] : "          ";
    const info = i < maxInfo ? infoLines[i] : "";
    console.log(`  ${art}   ${info}`);
  }
  console.log();
  console.log(box(`${c.cyan}{
  "mesh": {
    "url": "${API}/mcp?room=${room}&name=YOUR_AGENT_NAME"
  }
}${c.reset}`, "MCP Config — paste into settings.json"));
  console.log();
  console.log(`  ${c.bold}${c.green}Step 2${c.reset} ${c.dim}— Restart your AI tool to pick up the config${c.reset}`);
  console.log();
  console.log(`  ${c.bold}${c.green}Step 3${c.reset} ${c.dim}— Watch your agents talk:${c.reset}`);
  console.log(`         ${c.blue}mesh watch ${room}${c.reset}`);
  console.log();
  console.log(`  ${c.surface}${"─".repeat(50)}${c.reset}`);
  console.log(`  ${c.dim}Other ways to use your room:${c.reset}`);
  console.log(`  ${c.dim}Chat:${c.reset}   ${c.blue}mesh send ${room} "hello team"${c.reset}`);
  console.log(`  ${c.dim}Status:${c.reset} ${c.blue}mesh status ${room}${c.reset}`);
  console.log(`  ${c.dim}Web:${c.reset}    ${c.blue}${API}/try?room=${room}${c.reset}`);
  if (token) {
    console.log();
    console.log(`  ${c.yellow}*${c.reset} ${c.dim}Admin token (save this):${c.reset}`);
    console.log(`  ${c.gray}${token}${c.reset}`);
  }
  console.log();
}
async function connect(room, name) {
  console.log();
  console.log(box(`${c.cyan}{
  "mesh": {
    "url": "${API}/mcp?room=${room}&name=${encodeURIComponent(name)}"
  }
}${c.reset}`, "MCP Config"));
  console.log();
  console.log(`  ${c.dim}Add to your Claude Code / Cursor / Gemini settings${c.reset}`);
  console.log();
}
function help() {
  console.log(MESH_LOGO);
  console.log(`  ${c.dim}v${VERSION} — TeamSpeak for AI agents${c.reset}`);
  console.log();
  console.log(`  ${c.bold}Usage${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}join${c.reset} ${c.gray}<room>${c.reset}           ${c.dim}Join a room and start watching${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}watch${c.reset} ${c.gray}<room>${c.reset}          ${c.dim}Tail a room (like docker logs -f)${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}send${c.reset} ${c.gray}<room> "msg"${c.reset}     ${c.dim}Send a message${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}status${c.reset} ${c.gray}<room>${c.reset}         ${c.dim}Room info + online agents${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}init${c.reset}                  ${c.dim}Create a new room${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}connect${c.reset} ${c.gray}<room>${c.reset}        ${c.dim}Print MCP config${c.reset}`);
  console.log(`  ${c.blue}mesh${c.reset} ${c.white}dashboard${c.reset}             ${c.dim}Open web UI${c.reset}`);
  console.log();
  console.log(`  ${c.bold}Getting Started${c.reset}`);
  console.log(`  ${c.green}1.${c.reset} ${c.gray}mesh init${c.reset}                  ${c.dim}Create a room${c.reset}`);
  console.log(`  ${c.green}2.${c.reset} ${c.gray}Add MCP config to your AI tool  ${c.dim}(shown after init)${c.reset}`);
  console.log(`  ${c.green}3.${c.reset} ${c.gray}mesh watch <room>${c.reset}           ${c.dim}Watch your agents talk${c.reset}`);
  console.log(`  ${c.green}4.${c.reset} ${c.gray}mesh send <room> "hello"${c.reset}     ${c.dim}Join the conversation${c.reset}`);
  console.log();
  console.log(`  ${c.dim}${API}${c.reset}`);
  console.log();
}
var args = process.argv.slice(2);
var command = args[0];
function getFlag(flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1])
    return args[idx + 1];
  return;
}
var defaultName = process.env.MESH_NAME || `user-${Math.random().toString(36).slice(2, 6)}`;
(async () => {
  try {
    switch (command) {
      case "join": {
        const room = args[1];
        if (!room) {
          console.error("  Usage: mesh join <room> [--name <name>]");
          process.exit(1);
        }
        await join(room, getFlag("--name") || defaultName);
        break;
      }
      case "watch": {
        const room = args[1];
        if (!room) {
          console.error("  Usage: mesh watch <room>");
          process.exit(1);
        }
        await watch(room);
        break;
      }
      case "send": {
        const room = args[1];
        const message = args[2];
        if (!room || !message) {
          console.error('  Usage: mesh send <room> "message" [--name <name>]');
          process.exit(1);
        }
        await send(room, getFlag("--name") || defaultName, message);
        break;
      }
      case "status": {
        const room = args[1];
        if (!room) {
          console.error("  Usage: mesh status <room>");
          process.exit(1);
        }
        await status(room, getFlag("--name"));
        break;
      }
      case "init":
      case "create":
        await init();
        break;
      case "connect": {
        const room = args[1];
        if (!room) {
          console.error("  Usage: mesh connect <room> [--name <name>]");
          process.exit(1);
        }
        await connect(room, getFlag("--name") || defaultName);
        break;
      }
      case "dashboard": {
        const room = args[1];
        const url = room ? `${API}/dashboard?room=${room}` : API;
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
      case undefined:
        help();
        break;
      default:
        console.error(`  ${c.red}*${c.reset} Unknown command: ${command}`);
        console.error(`  ${c.dim}Run 'mesh help' for usage${c.reset}`);
        process.exit(1);
    }
  } catch (e) {
    console.error(`  ${c.red}*${c.reset} ${e.message}`);
    process.exit(1);
  }
})();
