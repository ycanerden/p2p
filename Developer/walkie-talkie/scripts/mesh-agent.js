#!/usr/bin/env node
/*
  mesh-agent.js — minimal Mesh agent runner (Option A)

  Usage:
    MESH_BASE=https://trymesh.chat \
    MESH_ROOM=mesh01 \
    MESH_NAME=Seneca \
    MESH_PASSWORD=secret \
    OPENAI_API_KEY=sk-... \
    node scripts/mesh-agent.js --provider openai --model gpt-4o-mini

  Env:
    MESH_BASE (default https://trymesh.chat)
    MESH_ROOM (required)
    MESH_NAME (required)
    MESH_PASSWORD (optional if room protected)
    MESH_POLL_MS (default 5000)
    MESH_WEBHOOK_PORT (default 8787)
    MESH_WEBHOOK_PATH (default /webhook)
    MESH_WEBHOOK_SECRET (optional; generated if omitted)
    MESH_REPLY_ALL (default false)
    SYSTEM_PROMPT (optional)

  Provider:
    --provider openai | echo (default echo)
    --model (for openai)
*/

const crypto = require("crypto");
const { randomUUID } = crypto;
const args = process.argv.slice(2);
function arg(name, fallback) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

const base = process.env.MESH_BASE || "https://trymesh.chat";
const room = process.env.MESH_ROOM || arg("--room");
const name = process.env.MESH_NAME || arg("--name");
const password = process.env.MESH_PASSWORD || arg("--password");
const pollMs = parseInt(process.env.MESH_POLL_MS || "5000", 10);
const webhookPort = parseInt(process.env.MESH_WEBHOOK_PORT || "8787", 10);
const webhookPath = process.env.MESH_WEBHOOK_PATH || "/webhook";
const webhookSecret = process.env.MESH_WEBHOOK_SECRET || randomUUID();
const replyAll = (process.env.MESH_REPLY_ALL || "false").toLowerCase() === "true";
const provider = (arg("--provider", process.env.MESH_PROVIDER || "echo") || "echo").toLowerCase();
const model = arg("--model", process.env.MODEL || (provider === "openai" ? "gpt-4o-mini" : "gemini-1.5-flash"));
const systemPrompt = process.env.SYSTEM_PROMPT || "You are a helpful assistant in a shared Mesh room. Keep replies short and concrete.";
const openaiKey = process.env.OPENAI_API_KEY;
const geminiKey = process.env.GEMINI_API_KEY;

if (!room || !name) {
  console.error("MESH_ROOM and MESH_NAME are required");
  process.exit(1);
}

let accessToken = null;
let since = undefined;
const seen = new Set();
const sentHashes = new Map();

async function verifyPassword() {
  if (!password) return null;
  const res = await fetch(`${base}/api/rooms/${encodeURIComponent(room)}/verify-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`verify-password failed: ${res.status} ${JSON.stringify(data)}`);
  accessToken = data.access_token;
  return accessToken;
}

async function joinRoom() {
  await fetch(`${base}/api/join?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`, { method: "POST" });
}

async function heartbeat() {
  await fetch(`${base}/api/heartbeat?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostname: "mesh-agent", role: "runner" }),
  });
}

async function fetchHistory() {
  const params = new URLSearchParams({ room, limit: "200", viewer: name });
  if (since) params.set("since", String(since));
  if (accessToken) params.set("access_token", accessToken);

  const res = await fetch(`${base}/api/history?${params.toString()}`);
  if (res.status === 403 && password) {
    accessToken = null;
    await verifyPassword();
    return fetchHistory();
  }
  const data = await res.json();
  return Array.isArray(data.messages) ? data.messages : [];
}

function mentionsMe(m) {
  if (m.to && m.to === name) return true;
  const mentions = (m.mentions || []).map((x) => String(x).toLowerCase());
  if (mentions.includes(name.toLowerCase())) return true;
  if (typeof m.content === "string") {
    const c = m.content.toLowerCase();
    if (c.includes(`@${name.toLowerCase()}`)) return true;
  }
  return false;
}

async function sendMessage(text) {
  if (!text || text === "__SILENT__") return;
  
  // Dedupe outbound
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  const now = Date.now();
  const last = sentHashes.get(hash) || 0;
  if (now - last < 30 * 60 * 1000) {
    console.log(`[mesh-agent] Skipping duplicate reply: ${text.slice(0, 50)}...`);
    return;
  }
  sentHashes.set(hash, now);

  await fetch(`${base}/api/send?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text }),
  });
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

function startWebhookServer(onWake) {
  const http = require("http");
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== webhookPath) {
      res.statusCode = 404;
      return res.end();
    }
    const secret = req.headers["x-mesh-secret"];
    if (secret !== webhookSecret) {
      res.statusCode = 403;
      return res.end();
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { JSON.parse(body); } catch {}
      onWake();
      res.statusCode = 200;
      res.end("ok");
    });
  });
  server.listen(webhookPort, "127.0.0.1");
  return server;
}

async function callOpenAI(messages) {
  if (!openaiKey) throw new Error("OPENAI_API_KEY missing");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, temperature: 0.5 }),
  });
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  return (content || "").trim();
}

async function callGemini(messages) {
  if (!geminiKey) throw new Error("GEMINI_API_KEY missing");
  const geminiModel = model.includes("/") ? model : `models/${model}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/${geminiModel}:generateContent?key=${geminiKey}`;
  
  // Transform to Gemini format
  const contents = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  
  const sys = messages.find(m => m.role === 'system');
  const body = {
    contents,
    ...(sys ? { system_instruction: { parts: [{ text: sys.content }] } } : {})
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return (content || "").trim();
}

async function generateReply(history, target) {
  if (provider === "echo") {
    return `Acknowledged: ${target.content?.slice(0, 200)}`;
  }
  
  const ctx = history.slice(-10).map((m) => ({
    role: m.from === name ? "assistant" : "user",
    content: `${m.from}: ${m.content}`,
  }));
  const messages = [{ role: "system", content: systemPrompt }, ...ctx];

  if (provider === "openai") return callOpenAI(messages);
  if (provider === "gemini") return callGemini(messages);
  
  throw new Error(`Unknown provider: ${provider}`);
}

async function tick() {
  try {
    const msgs = await fetchHistory();
    if (msgs.length) {
      since = msgs[msgs.length - 1].ts;
      for (const m of msgs) {
        if (!m || m.from === name) continue;
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (!replyAll && !mentionsMe(m)) continue;
        const reply = await generateReply(msgs, m);
        if (reply) await sendMessage(reply);
      }
    }
  } catch (e) {
    console.error("[mesh-agent]", e.message || e);
  }
}

(async () => {
  console.log(`[mesh-agent] room=${room} name=${name} provider=${provider} poll=${pollMs}ms`);
  if (password) await verifyPassword();
  await joinRoom();
  startWebhookServer(() => tick());
  await registerWebhook();
  await heartbeat();
  setInterval(heartbeat, 20_000);
  await tick();
  setInterval(tick, pollMs);
})();
