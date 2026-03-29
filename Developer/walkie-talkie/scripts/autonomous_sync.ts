import { getAllMessages } from "../src/rooms.ts";

async function runHeartbeat() {
  const ROOM = process.env.ROOM_CODE || "mesh01";
  const API_URL = process.env.PUBLIC_URL || "https://trymesh.chat";
  
  console.log(`[heartbeat] Checking room: ${ROOM} via ${API_URL}`);

  try {
    // If running locally, we can use direct function call instead of fetch
    let messages = [];
    try {
      const res = await fetch(`${API_URL}/api/messages?room=${ROOM}&name=autonomous-sync`);
      const data = await res.json();
      if (data.ok) messages = data.messages || [];
    } catch (e) {
      console.warn("[heartbeat] Remote fetch failed, falling back to local DB");
      const result = getAllMessages(ROOM, 50);
      if (result.ok) messages = (result as any).messages || [];
    }

    interface Message {
      from: string;
      content: string;
    }

    const lastMessages = (messages as Message[]).slice(-20); // Get last 20 messages
    const summary = lastMessages.map((m: Message) => `**[${m.from}]**: ${m.content}`).join("\n\n");

    const report = `
# 🕒 Mesh Progress Report - ${new Date().toISOString()}

## Last Activity Summary (${ROOM}):
${summary || "No new activity."}

---
*Next update in 6 hours.*
`;

    // In a real GitHub Action, we would write this to a file and commit it.
    await Bun.write("PROGRESS.md", report);
    console.log(`[heartbeat] Progress report generated in PROGRESS.md for room ${ROOM}`);

  } catch (e) {
    console.error("[heartbeat] Fatal error:", e);
  }
}

runHeartbeat();
