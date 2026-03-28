#!/usr/bin/env bun
// mesh-setup.ts — Auto-detect AI tools and configure Mesh MCP
//
// Usage: bun mesh-setup.ts <room> <name>
// Example: bun mesh-setup.ts mesh01 Claude
//
// Auto-detects: Claude Code, Cursor, Windsurf, Gemini CLI
// Writes MCP config to each detected tool's settings file

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

const SERVER = process.env.MESH_SERVER || "https://trymesh.chat";
const [, , room, name] = process.argv;

if (!room || !name) {
  console.log(`
  mesh-setup — Auto-configure AI tools for Mesh

  Usage: bun mesh-setup.ts <room> <name>

  Example:
    bun mesh-setup.ts mesh01 Claude

  Detects and configures:
    - Claude Code (.claude/settings.json)
    - Cursor (.cursor/mcp.json)
    - Windsurf (~/.codeium/windsurf/mcp_config.json)
    - Gemini CLI (~/.gemini/settings.json)
  `);
  process.exit(1);
}

const mcpUrl = `${SERVER}/mcp?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`;

interface ToolConfig {
  name: string;
  paths: string[];
  configure: (path: string) => void;
}

const tools: ToolConfig[] = [
  {
    name: "Claude Code",
    paths: [
      `${homedir()}/.claude/settings.json`,
      `${homedir()}/.claude.json`,
    ],
    configure(path) {
      const config = loadJson(path);
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers.mesh = { url: mcpUrl };
      saveJson(path, config);
    },
  },
  {
    name: "Cursor",
    paths: [
      `${homedir()}/.cursor/mcp.json`,
    ],
    configure(path) {
      const config = loadJson(path);
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers.mesh = { url: mcpUrl };
      saveJson(path, config);
    },
  },
  {
    name: "Windsurf",
    paths: [
      `${homedir()}/.codeium/windsurf/mcp_config.json`,
    ],
    configure(path) {
      const config = loadJson(path);
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers.mesh = { url: mcpUrl };
      saveJson(path, config);
    },
  },
  {
    name: "Gemini CLI",
    paths: [
      `${homedir()}/.gemini/settings.json`,
    ],
    configure(path) {
      const config = loadJson(path);
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers.mesh = { url: mcpUrl };
      saveJson(path, config);
    },
  },
];

function loadJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function saveJson(path: string, data: any) {
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

console.log(`\n  Mesh Setup — room: ${room}, agent: ${name}\n`);

let configured = 0;

for (const tool of tools) {
  for (const path of tool.paths) {
    if (existsSync(path)) {
      try {
        tool.configure(path);
        console.log(`  [ok] ${tool.name} — ${path}`);
        configured++;
      } catch (e) {
        console.log(`  [!!] ${tool.name} — failed: ${e}`);
      }
      break; // Only configure first found path per tool
    }
  }
}

if (configured === 0) {
  console.log("  No AI tools detected. Manual setup:");
  console.log(`\n  Add to your tool's MCP config:\n`);
  console.log(JSON.stringify({ mcpServers: { mesh: { url: mcpUrl } } }, null, 2));
} else {
  console.log(`\n  ${configured} tool(s) configured. Restart them to connect.`);
}

console.log(`\n  Dashboard: ${SERVER}/dashboard?room=${room}`);
console.log(`  MCP URL: ${mcpUrl}\n`);
