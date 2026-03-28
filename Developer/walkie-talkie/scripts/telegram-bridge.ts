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

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MESH_SERVER = process.env.MESH_SERVER || "https://trymesh.chat";
const MESH_ROOM = process.env.MESH_ROOM || "mesh01";
const MESH_NAME = process.env.MESH_NAME || "TelegramBridge";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // Set after first message

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
let chatId = TELEGRAM_CHAT_ID || "";
let lastUpdateId = 0;

// Send message to Telegram
async function sendToTelegram(text: string) {
  if (!chatId) return;
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      }),
    });
  } catch (e) {
    console.error("[telegram] Send failed:", e);
  }
}

// Send message to Mesh
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

// Poll Telegram for new messages
async function pollTelegram() {
  try {
    const res = await fetch(
      `${TELEGRAM_API}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`
    );
    const data = await res.json();

    if (data.ok && data.result?.length) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg?.text) continue;

        // Auto-detect chat ID from first message
        if (!chatId) {
          chatId = String(msg.chat.id);
          console.log(`[bridge] Chat ID detected: ${chatId}`);
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

// Listen to Mesh via SSE
async function listenToMesh() {
  console.log(`[bridge] Connecting to Mesh SSE: room=${MESH_ROOM}`);
  try {
    const res = await fetch(
      `${MESH_SERVER}/api/stream?room=${encodeURIComponent(MESH_ROOM)}&name=${encodeURIComponent(MESH_NAME)}`
    );

    if (!res.body) {
      console.error("[mesh] No SSE body");
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value);
      const lines = text.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ") && line !== "data: heartbeat") {
          try {
            const msg = JSON.parse(line.slice(6));
            // Don't echo back messages from Telegram users or self
            if (msg.from?.includes("(Telegram)")) continue;
            if (msg.from === MESH_NAME) continue;

            // STRICT FILTER: Only relay DECISION/RESOLUTION events + @Vincent/@Can mentions
            // NEVER relay BROADCAST messages to avoid spamming Vincent's phone
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
    }
  } catch (e) {
    console.error("[mesh] SSE error:", e);
    // Reconnect after 5 seconds
    setTimeout(listenToMesh, 5000);
  }
}

// Main
console.log(`
  Mesh ↔ Telegram Bridge
  Room: ${MESH_ROOM}
  Bot: ${MESH_NAME}
  Server: ${MESH_SERVER}

  Waiting for messages...
`);

// Start both directions
listenToMesh();

// Poll Telegram every 1 second (long polling with 30s timeout)
const poll = async () => {
  while (true) {
    await pollTelegram();
    await new Promise((r) => setTimeout(r, 1000));
  }
};
poll();
