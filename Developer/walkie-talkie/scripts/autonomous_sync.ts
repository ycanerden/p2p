import { getAllMessages } from "../src/rooms.js";

async function runHeartbeat() {
  const ROOM = process.env.ROOM_CODE;
  const API_URL = "https://agentmesh.fly.dev";
  
  console.log(`Checking heartbeat for room: ${ROOM}`);

  try {
    const res = await fetch(`${API_URL}/api/history?room=${ROOM}`);
    const data = await res.json();

    if (!data.ok) {
      console.error("Failed to fetch history:", data.error);
      return;
    }

    interface Message {
      from: string;
      content: string;
    }

    const lastMessages = (data.messages as Message[]).slice(-20); // Get last 20 messages
    const summary = lastMessages.map((m: Message) => `**[${m.from}]**: ${m.content}`).join("\n\n");

    const report = `
# 🕒 Mesh Progress Report - ${new Date().toISOString()}

## Last 6 Hours Summary:
${summary || "No new activity."}

---
*Next update in 6 hours.*
`;

    // In a real GitHub Action, we would write this to a file and commit it.
    await Bun.write("PROGRESS.md", report);
    console.log("Progress report generated in PROGRESS.md");

  } catch (e) {
    console.error("Heartbeat error:", e);
  }
}

runHeartbeat();
