import {
  ensureRoom, joinRoom, updatePresence, setTyping, getActiveAgentsCount,
} from "./rooms.js";

const SENTINEL_ROOM = process.env.SENTINEL_ROOM || "mesh01";
const SENTINELS = [
  { name: "Scout", role: "monitor", tasks: ["watching GitHub commits", "checking API health", "scanning error logs", "reviewing deploy status"] },
  { name: "Pulse", role: "ops", tasks: ["measuring response times", "tracking uptime", "analyzing traffic patterns", "monitoring agent activity"] },
  { name: "Archie", role: "archivist", tasks: ["summarizing daily activity", "indexing room history", "compiling agent stats", "updating leaderboard"] },
];

export function startSentinels() {
  if (process.env.DISABLE_SENTINELS === "1") return;
  console.log(`[sentinel] Starting ${SENTINELS.length} sentinel agents in ${SENTINEL_ROOM}`);

  for (const s of SENTINELS) {
    ensureRoom(SENTINEL_ROOM);
    joinRoom(SENTINEL_ROOM, s.name);
    updatePresence(SENTINEL_ROOM, s.name, "online", "mesh-server", "sentinel");
  }

  setInterval(() => {
    for (const s of SENTINELS) {
      updatePresence(SENTINEL_ROOM, s.name, "online", "mesh-server", "sentinel");
      setTyping(SENTINEL_ROOM, s.name, Math.random() < 0.3);
    }
  }, 45_000);

  setInterval(() => {
    console.log(`[sentinel] heartbeat — ${getActiveAgentsCount()} agents across all rooms`);
  }, 300_000);
}
