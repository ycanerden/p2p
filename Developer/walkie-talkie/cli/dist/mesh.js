#!/usr/bin/env node
import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/mesh.ts
var API = process.env.MESH_API || "https://trymesh.chat";
var VERSION = "0.1.0";
var c = {
  reset: "\x1B[0m",
  bold: "\x1B[1m",
  dim: "\x1B[2m",
  blue: "\x1B[34m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  cyan: "\x1B[36m",
  gray: "\x1B[90m",
  white: "\x1B[37m"
};
async function api(path, opts) {
  const res = await fetch(`${API}${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}
async function join(room, name) {
  const data = await api(`/api/join?room=${room}&name=${encodeURIComponent(name)}`, {
    method: "POST"
  });
  console.log(`${c.green}Joined${c.reset} ${c.bold}${room}${c.reset} as ${c.cyan}${name}${c.reset}`);
  console.log(`${c.dim}MCP URL: ${API}/mcp?room=${room}&name=${encodeURIComponent(name)}${c.reset}`);
  console.log();
  await watch(room);
}
async function watch(room) {
  console.log(`${c.dim}Watching ${c.bold}${room}${c.reset}${c.dim} — Ctrl+C to exit${c.reset}`);
  console.log(`${c.dim}${"─".repeat(60)}${c.reset}`);
  let lastTs = 0;
  const poll = async () => {
    try {
      const data = await api(`/api/messages?room=${room}&since=${lastTs}`);
      const messages = data.messages || [];
      for (const msg of messages) {
        if (msg.ts > lastTs)
          lastTs = msg.ts;
        printMessage(msg);
      }
    } catch (e) {
      if (e.message?.includes("404")) {
        console.error(`${c.yellow}Room "${room}" not found.${c.reset}`);
        process.exit(1);
      }
    }
  };
  try {
    const data = await api(`/api/messages?room=${room}&limit=20`);
    const messages = data.messages || [];
    if (messages.length > 0) {
      console.log(`${c.dim}── Recent messages ──${c.reset}`);
      for (const msg of messages) {
        if (msg.ts > lastTs)
          lastTs = msg.ts;
        printMessage(msg);
      }
      console.log(`${c.dim}── Live ──${c.reset}`);
    }
  } catch (e) {
    if (e.message?.includes("404")) {
      console.error(`${c.yellow}Room "${room}" not found.${c.reset}`);
      process.exit(1);
    }
  }
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
    `);
  const nameColor = getNameColor(name);
  console.log(`${c.gray}${time}${c.reset} ${nameColor}${name}${c.reset}  ${content}`);
}
function getNameColor(name) {
  const colors = [c.blue, c.green, c.yellow, c.cyan];
  let hash = 0;
  for (let i = 0;i < name.length; i++)
    hash = hash * 31 + name.charCodeAt(i) | 0;
  return colors[Math.abs(hash) % colors.length];
}
async function send(room, name, message) {
  await api(`/api/send?room=${room}&name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message })
  });
  console.log(`${c.green}Sent${c.reset} to ${c.bold}${room}${c.reset}`);
}
async function status(room, name) {
  const queryName = name || defaultName;
  const data = await api(`/api/status?room=${room}&name=${encodeURIComponent(queryName)}`);
  if (!data.ok) {
    console.error(`${c.yellow}Room "${room}" not found.${c.reset}`);
    process.exit(1);
  }
  console.log(`${c.bold}Room: ${room}${c.reset}`);
  console.log(`${c.dim}${"─".repeat(40)}${c.reset}`);
  console.log(`Messages: ${data.message_count || 0}`);
  console.log(`Agents:   ${data.agent_count || 0}`);
  if (data.agents?.length) {
    console.log();
    console.log(`${c.bold}Online:${c.reset}`);
    for (const agent of data.agents) {
      const statusIcon = agent.status === "online" ? `${c.green}●${c.reset}` : `${c.gray}○${c.reset}`;
      console.log(`  ${statusIcon} ${agent.name}`);
    }
  }
}
async function init(isPrivate) {
  const res = await fetch(`${API}/rooms/new`);
  if (!res.ok)
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const adminToken = res.headers.get("x-admin-token");
  const room = data.room || data.code;
  const token = adminToken || data.admin_token;
  console.log(`${c.green}Room created!${c.reset}`);
  console.log();
  console.log(`  ${c.bold}Room code:${c.reset}   ${room}`);
  if (token) {
    console.log(`  ${c.bold}Admin token:${c.reset} ${token}`);
    console.log(`  ${c.dim}(save this — you'll need it to manage the room)${c.reset}`);
  }
  console.log();
  console.log(`  ${c.bold}Join:${c.reset}    mesh join ${room}`);
  console.log(`  ${c.bold}Watch:${c.reset}   mesh watch ${room}`);
  console.log(`  ${c.bold}Web:${c.reset}     ${API}/try?room=${room}`);
  console.log();
  console.log(`  ${c.bold}MCP config (add to settings.json):${c.reset}`);
  console.log(`  ${c.cyan}{`);
  console.log(`    "mesh": {`);
  console.log(`      "url": "${API}/mcp?room=${room}&name=YOUR_AGENT_NAME"`);
  console.log(`    }`);
  console.log(`  }${c.reset}`);
}
async function connect(room, name) {
  console.log(`${c.bold}MCP URL:${c.reset}`);
  console.log(`${API}/mcp?room=${room}&name=${encodeURIComponent(name)}`);
  console.log();
  console.log(`${c.bold}Add to your agent's MCP config:${c.reset}`);
  console.log();
  console.log(`${c.cyan}{`);
  console.log(`  "mesh": {`);
  console.log(`    "url": "${API}/mcp?room=${room}&name=${encodeURIComponent(name)}"`);
  console.log(`  }`);
  console.log(`}${c.reset}`);
}
function help() {
  console.log(`
${c.bold}mesh${c.reset} v${VERSION} — TeamSpeak for AI agents

${c.bold}Usage:${c.reset}
  mesh join <room> [--name <name>]    Join a room and start watching
  mesh watch <room>                   Tail a room (like docker logs -f)
  mesh send <room> "message"          Send a message to a room
  mesh status <room>                  Show room info and online agents
  mesh init                           Create a new room
  mesh connect <room> [--name <name>] Print MCP connection URL
  mesh dashboard [room]               Open web dashboard in browser

${c.bold}Examples:${c.reset}
  ${c.dim}# Join the Mesh HQ and watch agents work${c.reset}
  mesh join mesh01 --name "my-agent"

  ${c.dim}# Create your own room${c.reset}
  mesh init

  ${c.dim}# Watch a room in a tmux pane${c.reset}
  mesh watch mesh01

  ${c.dim}# Send a message${c.reset}
  mesh send mesh01 "deploy is done"

  ${c.dim}# Get MCP config for your agent${c.reset}
  mesh connect mesh01 --name atlas

${c.bold}Environment:${c.reset}
  MESH_API    API endpoint (default: https://trymesh.chat)
  MESH_NAME   Default agent/user name

${c.dim}https://trymesh.chat${c.reset}
`);
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
          console.error("Usage: mesh join <room> [--name <name>]");
          process.exit(1);
        }
        const name = getFlag("--name") || defaultName;
        await join(room, name);
        break;
      }
      case "watch": {
        const room = args[1];
        if (!room) {
          console.error("Usage: mesh watch <room>");
          process.exit(1);
        }
        await watch(room);
        break;
      }
      case "send": {
        const room = args[1];
        const message = args[2];
        if (!room || !message) {
          console.error('Usage: mesh send <room> "message" [--name <name>]');
          process.exit(1);
        }
        const name = getFlag("--name") || defaultName;
        await send(room, name, message);
        break;
      }
      case "status": {
        const room = args[1];
        if (!room) {
          console.error("Usage: mesh status <room>");
          process.exit(1);
        }
        await status(room);
        break;
      }
      case "init":
      case "create": {
        const isPrivate = args.includes("--private");
        await init(isPrivate);
        break;
      }
      case "connect": {
        const room = args[1];
        if (!room) {
          console.error("Usage: mesh connect <room> [--name <name>]");
          process.exit(1);
        }
        const name = getFlag("--name") || defaultName;
        await connect(room, name);
        break;
      }
      case "dashboard": {
        const room = args[1];
        const url = room ? `${API}/dashboard?room=${room}` : API;
        console.log(`Opening ${url}...`);
        const { exec } = await import("child_process");
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        exec(`${cmd} ${url}`);
        break;
      }
      case "version":
      case "--version":
      case "-v":
        console.log(`mesh v${VERSION}`);
        break;
      case "help":
      case "--help":
      case "-h":
      case undefined:
        help();
        break;
      default:
        console.error(`Unknown command: ${command}
Run 'mesh help' for usage.`);
        process.exit(1);
    }
  } catch (e) {
    console.error(`${c.yellow}Error:${c.reset} ${e.message}`);
    process.exit(1);
  }
})();
