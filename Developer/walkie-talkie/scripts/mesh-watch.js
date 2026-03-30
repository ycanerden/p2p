#!/usr/bin/env node
/*
  mesh-watch.js — poll Mesh room for new messages
  Env:
    MESH_BASE (default https://p2p-production-983f.up.railway.app)
    MESH_ROOM (required)
    MESH_NAME (default Seneca)
    MESH_PASSWORD (required for protected rooms)
    POLL_MS (default 300000)
*/

const base = process.env.MESH_BASE || "https://p2p-production-983f.up.railway.app";
const room = process.env.MESH_ROOM;
const name = process.env.MESH_NAME || "Seneca";
const password = process.env.MESH_PASSWORD;
const pollMs = parseInt(process.env.POLL_MS || "300000", 10);

if (!room) {
  console.error("MESH_ROOM is required");
  process.exit(1);
}
if (!password) {
  console.error("MESH_PASSWORD is required for protected rooms");
  process.exit(1);
}

let accessToken = null;
let since = undefined;

async function verifyPassword() {
  const res = await fetch(`${base}/api/rooms/${encodeURIComponent(room)}/verify-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`verify-password failed: ${res.status} ${JSON.stringify(data)}`);
  }
  accessToken = data.access_token;
}

async function fetchHistory() {
  if (!accessToken) await verifyPassword();
  const params = new URLSearchParams({
    room,
    access_token: accessToken,
    limit: "200",
  });
  if (since) params.set("since", String(since));

  const res = await fetch(`${base}/api/history?${params.toString()}`);
  if (res.status === 403) {
    // token may be stale, re-verify and retry once
    accessToken = null;
    await verifyPassword();
    return fetchHistory();
  }
  const data = await res.json();
  if (!data.messages) return [];
  return data.messages;
}

function printMessage(m) {
  const ts = new Date(m.ts).toISOString();
  const to = m.to ? ` -> ${m.to}` : "";
  console.log(`[${ts}] ${m.from}${to}: ${m.content}`);
}

async function tick() {
  try {
    const msgs = await fetchHistory();
    if (msgs.length) {
      msgs.forEach(printMessage);
      const last = msgs[msgs.length - 1];
      since = last.ts;
    }
  } catch (err) {
    console.error("[mesh-watch] error:", err.message || err);
  }
}

(async () => {
  console.log(`[mesh-watch] room=${room} base=${base} poll=${pollMs}ms name=${name}`);
  // prime: avoid dumping whole history
  const initial = await fetchHistory();
  if (initial.length) since = initial[initial.length - 1].ts;
  setInterval(tick, pollMs);
})();
