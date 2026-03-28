#!/usr/bin/env bun
// telegram-bridge.ts — Bridge between a Telegram group and a Mesh room
//
// Setup:
//   1. Create a bot via @BotFather on Telegram
//   2. Add the bot to your Telegram group
//   3. Set environment variables:
//      TELEGRAM_BOT_TOKEN=your_bot_token
//      MESH_ROOM=mesh01
//      MESH_NAME=TelegramBridge
//   4. Run: bun telegram-bridge.ts
//
// Messages flow both ways:
//   Telegram group → Mesh room
//   Mesh room → Telegram group

import { existsSync, readFileSync, writeFileSync } from "fs";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MESH_SERVER = process.env.MESH_SERVER || "https://p2p-production-983f.up.railway.app";
const MESH_ROOM = process.env.MESH_ROOM || "mesh01";
const MESH_NAME = process.env.MESH_NAME || "TelegramBridge";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = process.env.BRIDGE_STATE_FILE || ".bridge-state.json";

if (!BOT_TOKEN) {
  console.log(`
  Telegram Bridge for Mesh

  Setup:
    1. Talk to @BotFather on Telegram → /newbot → get token
    2. Add bot to your Telegram group
    3. Run:

       TELEGRAM_BOT_TOKEN=your_token MESH_ROOM=mesh01 bun telegram-bridge.ts

    4. Send a message in the Telegram group — the bridge auto-detects the chat ID
    5. All messages now flow both ways!
  `);
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Persisted state (survives restarts) ──────────────────────────────────────
interface BridgeState { lastUpdateId: number; chatId: string; }

function loadState(): BridgeState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf8")) as BridgeState;
    }
  } catch {}
  return { lastUpdateId: 0, chatId: TELEGRAM_CHAT_ID || "" };
}

function saveState(state: BridgeState) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
}

const state = loadState();
if (TELEGRAM_CHAT_ID && !state.chatId) state.chatId = TELEGRAM_CHAT_ID;

// ── Telegram send ─────────────────────────────────────────────────────────────
async function sendToTelegram(text: string) {
  if (!state.chatId) return;
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: state.chatId, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.error("[telegram] Send failed:", e);
  }
}

// ── Mesh send ─────────────────────────────────────────────────────────────────
async function sendToMesh(from: string, text: string) {
  try {
    await fetch(
      `${MESH_SERVER}/api/send?room=${encodeURIComponent(MESH_ROOM)}&name=${encodeURIComponent(from)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, type: "BROADCAST" }),
      }
    );
  } catch (e) {
    console.error("[mesh] Send failed:", e);
  }
}

// ── Telegram poll ─────────────────────────────────────────────────────────────
async function pollTelegram() {
  try {
    const res = await fetch(
      `${TELEGRAM_API}/getUpdates?offset=${state.lastUpdateId + 1}&timeout=30`
    );
    const data = await res.json() as any;

    if (data.ok && data.result?.length) {
      for (const update of data.result) {
        // Always advance offset even if we skip the message
        if (update.update_id > state.lastUpdateId) {
          state.lastUpdateId = update.update_id;
          saveState(state);
        }
        const msg = update.message;
        if (!msg?.text) continue;

        // Auto-detect chat ID from first message
        if (!state.chatId) {
          state.chatId = String(msg.chat.id);
          saveState(state);
          console.log(`[bridge] Chat ID detected: ${state.chatId}`);
          await sendToTelegram("Bridge connected to Mesh room: " + MESH_ROOM);
        }

        const from = msg.from?.first_name || msg.from?.username || "Unknown";
        console.log(`[telegram→mesh] ${from}: ${msg.text}`);
        await sendToMesh(`${from} (Telegram)`, msg.text);
      }
    }
  } catch (e) {
    console.error("[telegram] Poll error:", e);
  }
}

// ── Mesh SSE listener with exponential backoff ────────────────────────────────
let sseReconnectAttempt = 0;
const SSE_MAX_DELAY = 60_000;

async function listenToMesh(): Promise<void> {
  console.log(`[bridge] Connecting to Mesh SSE (attempt ${sseReconnectAttempt + 1}): room=${MESH_ROOM}`);
  try {
    const res = await fetch(
      `${MESH_SERVER}/api/stream?room=${encodeURIComponent(MESH_ROOM)}&name=${encodeURIComponent(MESH_NAME)}`
    );

    if (!res.body) throw new Error("No SSE body");

    sseReconnectAttempt = 0; // Reset on successful connect
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value);
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ") || line === "data: heartbeat") continue;
        try {
          const msg = JSON.parse(line.slice(6));
          if (msg.from?.includes("(Telegram)")) continue;
          if (msg.from === MESH_NAME) continue;

          // STRICT FILTER: Only relay DECISION/RESOLUTION events + @Vincent/@Can mentions
          const type = (msg.type || "BROADCAST").toUpperCase();
          const content = (msg.content || msg.message || "").toLowerCase();
          const isDecision = type === "DECISION" || type === "RESOLUTION";
          const isMention = content.includes("@vincent") || content.includes("@can erden");
          if (!isDecision && !isMention) continue;

          const formatted = `[${type}] <b>${msg.from}</b>: ${msg.content || msg.message || ""}`;
          console.log(`[mesh→telegram] ${msg.from}: ${msg.content || ""}`);
          await sendToTelegram(formatted);
        } catch {}
      }
    }
  } catch (e) {
    console.error("[mesh] SSE error:", e);
  }

  // Exponential backoff: 2^attempt seconds, capped at 60s
  const delay = Math.min(1000 * Math.pow(2, sseReconnectAttempt), SSE_MAX_DELAY);
  sseReconnectAttempt++;
  console.log(`[bridge] Reconnecting in ${delay / 1000}s...`);
  setTimeout(listenToMesh, delay);
}

// ── Heartbeat — keeps bridge visible in /office presence ─────────────────────
async function sendHeartbeat() {
  try {
    await fetch(`${MESH_SERVER}/api/heartbeat?room=${encodeURIComponent(MESH_ROOM)}&name=${encodeURIComponent(MESH_NAME)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "bridge", hostname: "telegram-bridge" }),
    });
  } catch {}
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log(`
  Mesh ↔ Telegram Bridge
  Room: ${MESH_ROOM}
  Bot: ${MESH_NAME}
  Server: ${MESH_SERVER}
  State: ${STATE_FILE} (lastUpdateId=${state.lastUpdateId}, chatId=${state.chatId || "auto-detect"})

  Waiting for messages...
`);

listenToMesh();
sendHeartbeat();
setInterval(sendHeartbeat, 30_000);

const poll = async () => {
  while (true) {
    await pollTelegram();
    await new Promise((r) => setTimeout(r, 1000));
  }
};
poll();
