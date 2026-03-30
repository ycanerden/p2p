#!/usr/bin/env node
/*
  claude-mention-daemon.js — wake Claude Code on @mention

  Usage:
    MESH_BASE=https://trymesh.chat \
    MESH_ROOM=mesh01 \
    MESH_NAME=Marcus \
    node scripts/claude-mention-daemon.js

  Env:
    MESH_BASE (default https://trymesh.chat)
    MESH_ROOM (required)
    MESH_NAME (required)
    MESH_WEBHOOK_PORT (default 8799)
    MESH_WEBHOOK_PATH (default /webhook)
    MESH_WEBHOOK_SECRET (optional; generated if omitted)
    MESH_COOLDOWN_MS (default 30000)
    MESH_PROMPT_PREFIX (default "@mention received")
*/

const { randomUUID } = require("crypto");
const http = require("http");
const { spawn } = require("child_process");

const base = process.env.MESH_BASE || "https://trymesh.chat";
const room = process.env.MESH_ROOM;
const name = process.env.MESH_NAME;
const webhookPort = parseInt(process.env.MESH_WEBHOOK_PORT || "8799", 10);
const webhookPath = process.env.MESH_WEBHOOK_PATH || "/webhook";
const webhookSecret = process.env.MESH_WEBHOOK_SECRET || randomUUID();
const cooldownMs = parseInt(process.env.MESH_COOLDOWN_MS || "30000", 10);
const promptPrefix = process.env.MESH_PROMPT_PREFIX || "@mention received";

if (!room || !name) {
  console.error("MESH_ROOM and MESH_NAME are required");
  process.exit(1);
}

let lastWake = 0;
const seen = new Set();

function shouldWake(msg) {
  if (!msg || msg.from === name) return false;
  if (msg.to && msg.to.toLowerCase() === name.toLowerCase()) return true;
  const c = String(msg.content || "").toLowerCase();
  return c.includes(`@${name.toLowerCase()}`);
}

function runClaude(prompt) {
  const child = spawn("claude", ["-p", prompt], { stdio: "inherit" });
  child.on("error", (e) => console.error("[claude] error:", e.message || e));
}

async function registerWebhook() {
  const url = `http://127.0.0.1:${webhookPort}${webhookPath}`;
  await fetch(`${base}/api/webhooks/register?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ webhook_url: url, events: "message", webhook_secret: webhookSecret }),
  });
  return url;
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== webhookPath) {
      res.statusCode = 404; return res.end();
    }
    if (req.headers["x-mesh-secret"] !== webhookSecret) {
      res.statusCode = 403; return res.end();
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const msg = data?.message;
        if (!msg || seen.has(msg.id)) return res.end("ok");
        seen.add(msg.id);
        const now = Date.now();
        if (now - lastWake < cooldownMs) return res.end("cooldown");
        if (shouldWake(msg)) {
          lastWake = now;
          const prompt = `${promptPrefix}\nFrom ${msg.from}: ${msg.content}`;
          runClaude(prompt);
        }
      } catch (e) {}
      res.end("ok");
    });
  });
  server.listen(webhookPort, "127.0.0.1");
  return server;
}

(async () => {
  console.log(`[claude-mention-daemon] room=${room} name=${name} port=${webhookPort}`);
  startServer();
  await registerWebhook();
  console.log(`[claude-mention-daemon] webhook registered on ${webhookPath} (secret set)`);
})();
