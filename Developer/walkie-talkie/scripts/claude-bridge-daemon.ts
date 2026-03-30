/**
 * Claude Bridge Daemon
 * A lightweight SSE listener that wakes up Claude Code on @mentions.
 *
 * This solves the "Claude is blind to the room" problem by triggering
 * a 'claude -p' command whenever the agent is mentioned in Mesh.
 *
 * Usage:
 *   export SERVER_URL=https://trymesh.chat
 *   export ROOM=mesh01
 *   export NAME=MyAgent
 *   bun scripts/claude-bridge-daemon.ts
 */

import { spawn } from "node:child_process";

const SERVER_URL = process.env.SERVER_URL || "https://trymesh.chat";
const ROOM = process.env.ROOM || "mesh01";
const NAME = process.env.NAME || "Agent";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "/Users/vincentdemarez/.local/bin/claude";

// Message deduplication
const seenIds = new Set<string>();

async function startEventStream() {
  const params = `?room=${ROOM}&name=${NAME}`;
  console.log(`[bridge] 🔌 Connecting to ${SERVER_URL}/api/stream as ${NAME}`);

  try {
    const response = await fetch(`${SERVER_URL}/api/stream${params}`);
    if (!response.ok) {
      console.error(`[bridge] ❌ Server returned ${response.status}`);
      setTimeout(startEventStream, 5000);
      return;
    }

    if (!response.body) {
      console.error(`[bridge] ❌ No response body`);
      setTimeout(startEventStream, 5000);
      return;
    }

    console.log(`[bridge] ✅ Connected, watching for @${NAME}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let streamBuffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        console.warn(`[bridge] ⚠️ Stream closed by server`);
        break;
      }

      streamBuffer += decoder.decode(value, { stream: true });
      const parts = streamBuffer.split("\n\n");
      streamBuffer = parts.pop() || "";

      for (const part of parts) {
        if (!part.trim()) continue;

        if (part.includes("event: message")) {
          const lines = part.split("\n");
          const dataLine = lines.find(line => line.startsWith("data: "));
          if (dataLine) {
            try {
              const msg = JSON.parse(dataLine.slice(6));
              
              // Skip if we've seen it or it's from us
              if (seenIds.has(msg.id) || msg.from === NAME) continue;
              seenIds.add(msg.id);
              if (seenIds.size > 1000) {
                const first = seenIds.values().next().value;
                if (first) seenIds.delete(first);
              }

              // Check for @mention or direct message
              const isMention = msg.content.toLowerCase().includes(`@${NAME.toLowerCase()}`);
              const isDirect = msg.to === NAME;

              if (isMention || isDirect) {
                console.log(`[bridge] 🔔 Mention detected from ${msg.from}!`);
                triggerClaude(msg);
              }
            } catch (e) {
              console.error(`[bridge] ❌ Failed to parse message: ${e}`);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error(`[bridge] ❌ Error: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log(`[bridge] 🔄 Reconnecting in 5s...`);
  setTimeout(startEventStream, 5000);
}

/**
 * Trigger Claude Code via CLI
 */
function triggerClaude(msg: any) {
  const prompt = `[MESH NOTIFICATION] @${msg.from} mentioned you in room ${ROOM}: "${msg.content}". Please respond to them in the room.`;
  
  console.log(`[bridge] 🚀 Running: claude -p "${prompt.substring(0, 40)}..."`);

  // Run claude
  const child = spawn(CLAUDE_PATH, [
    "-p", prompt
  ], {
    stdio: "inherit",
    env: { ...process.env, MESH_ROOM: ROOM, MESH_NAME: NAME }
  });

  child.on("close", (code) => {
    console.log(`[bridge] 🏁 Claude process exited with code ${code}`);
  });
}

// Start the bridge
startEventStream().catch(console.error);

console.log(`
╔════════════════════════════════════════════════════════════╗
║         Claude Mesh Bridge Daemon                          ║
║                                                            ║
║  Agent: ${NAME.padEnd(30)}║
║  Room: ${ROOM.padEnd(35)}║
║  CLI:  ${CLAUDE_PATH.substring(0, 30).padEnd(30)}║
║                                                            ║
║  🔔 Listening for @mentions to trigger Claude Code...      ║
╚════════════════════════════════════════════════════════════╝
`);
