#!/usr/bin/env bun
// voice-agent.ts — Mesh Voice Agent (spike)
// Joins a Mesh room AND a voice call, bridges audio ↔ text
//
// Architecture:
//   Microphone → Whisper (local/API) → Mesh room messages
//   Mesh room messages → ElevenLabs/OpenAI TTS → Speaker
//
// Usage:
//   OPENAI_API_KEY=xxx bun voice-agent.ts --room mesh01 --name VoiceBot
//
// For Google Meet / Zoom integration:
//   Use Daily.co or LiveKit SDK — they provide virtual mic/speaker
//   that the agent controls programmatically

const MESH_SERVER = process.env.MESH_SERVER || "https://trymesh.chat";
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const args = process.argv.slice(2);
const room = args[args.indexOf("--room") + 1] || "mesh01";
const name = args[args.indexOf("--name") + 1] || "VoiceBot";

// ── 1. Connect to Mesh room ──────────────────────────────────────────────────

async function sendMessage(text: string) {
  await fetch(`${MESH_SERVER}/api/send?room=${room}&name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text }),
  });
}

async function heartbeat() {
  await fetch(`${MESH_SERVER}/api/heartbeat?room=${room}&name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostname: "voice-agent" }),
  });
}

// ── 2. Listen for Mesh messages (SSE) ────────────────────────────────────────

async function listenToRoom(onMessage: (from: string, text: string) => void) {
  const url = `${MESH_SERVER}/api/stream?room=${room}&name=${encodeURIComponent(name)}`;
  const resp = await fetch(url);
  if (!resp.body) return;

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.from && data.from !== name && data.content) {
            onMessage(data.from, data.content);
          }
        } catch {}
      }
    }
  }
}

// ── 3. Speech-to-Text (Whisper via OpenAI API) ──────────────────────────────
// For live mic: pipe microphone audio chunks to this function

async function transcribeAudio(audioBuffer: ArrayBuffer): Promise<string> {
  if (!OPENAI_KEY) return "[no OpenAI key — transcription disabled]";

  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "audio.wav");
  form.append("model", "whisper-1");

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: form,
  });
  const data = await resp.json() as any;
  return data.text || "";
}

// ── 4. Text-to-Speech (OpenAI TTS) ──────────────────────────────────────────

async function speak(text: string): Promise<ArrayBuffer | null> {
  if (!OPENAI_KEY) {
    console.log(`[TTS would say]: ${text}`);
    return null;
  }

  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "tts-1", voice: "onyx", input: text }),
  });
  return resp.arrayBuffer();
}

// ── 5. Main loop ─────────────────────────────────────────────────────────────

console.log(`\n  👺 Mesh Voice Agent`);
console.log(`  Room: ${room} | Name: ${name}`);
console.log(`  Server: ${MESH_SERVER}\n`);

// Heartbeat every 15s
setInterval(heartbeat, 15_000);
heartbeat();

await sendMessage(`🎙️ ${name} joined the room — voice agent online. I can listen and speak.`);

// Listen for messages and speak them aloud
listenToRoom(async (from, text) => {
  console.log(`  [${from}]: ${text.slice(0, 80)}`);

  // Only speak short messages to avoid TTS spam
  if (text.length < 200) {
    const audio = await speak(`${from} says: ${text}`);
    if (audio) {
      await Bun.write("/tmp/mesh_tts.mp3", audio);
      Bun.$`afplay /tmp/mesh_tts.mp3`.quiet();
    }  }
});

// ── 6. Google Meet / Livekit integration notes ───────────────────────────────
//
// To join a real video call:
//
// Option A — Daily.co:
//   import Daily from "@daily-co/daily-js"
//   const call = Daily.createCallObject()
//   await call.join({ url: "https://yourteam.daily.co/room" })
//   call.on("track-started", (e) => {
//     // pipe e.track (MediaStreamTrack) audio to Whisper
//   })
//
// Option B — LiveKit:
//   import { Room } from "livekit-client"
//   const room = new Room()
//   await room.connect(livekitUrl, token)
//   // publish TTS audio as a local track
//   // subscribe to remote audio tracks → Whisper
//
// Option C — Browser automation (hacky but works):
//   Puppeteer/Playwright + virtual audio device (BlackHole on macOS)
//   Chrome joins the Meet, agent captures audio via getUserMedia override
