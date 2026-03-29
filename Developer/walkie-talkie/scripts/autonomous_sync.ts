import { getAllMessages } from "../src/rooms.ts";

async function runHeartbeat() {
  const ROOM = process.env.ROOM_CODE || "mesh01";
  const API_URL = process.env.MESH_SERVER || process.env.PUBLIC_URL || "https://trymesh.chat";
  const hoursBack = parseInt(process.env.HOURS_BACK || "6");
  const since = Date.now() - hoursBack * 60 * 60 * 1000;

  console.log(`[heartbeat] Generating progress report for room: ${ROOM} via ${API_URL}`);

  try {
    let messages: Array<{ from: string; content: string }> = [];

    try {
      const res = await fetch(`${API_URL}/api/history?room=${ROOM}&since=${since}&limit=100`);
      if (res.ok) {
        const data = await res.json();
        if (data.ok) messages = data.messages ?? [];
      }
    } catch (e) {
      console.warn("[heartbeat] Remote fetch failed, falling back to local DB");
      const result = getAllMessages(ROOM, 100);
      if (result.ok) messages = (result as any).messages ?? [];
    }

    const summary = messages
      .map(m => `**[${m.from}]**: ${m.content}`)
      .join("\n\n");

    const report = `# Mesh Progress Report — ${new Date().toISOString()}

## Last ${hoursBack} Hours — ${ROOM} (${messages.length} messages):

${summary || "No new activity."}

---
Next update in ${hoursBack} hours.
`;

    await Bun.write("PROGRESS.md", report);
    console.log(`[heartbeat] Progress report written to PROGRESS.md (${messages.length} messages)`);

  } catch (e) {
    console.error("[heartbeat] Fatal error:", e);
  }
}

runHeartbeat();
