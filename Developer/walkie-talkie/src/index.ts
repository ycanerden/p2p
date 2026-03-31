import { Hono } from "hono";
import { applyMiddleware } from "./middleware.js";
import { sweepExpiredRooms, cleanOldMetrics, processScheduledMessages } from "./rooms.js";
import { startSentinels } from "./sentinels.js";
import { websocket, handleWsUpgrade } from "./websocket.js";

// Route modules
import api, { VERSION, startTime } from "./routes/api.js";
import admin from "./routes/admin.js";
import directory from "./routes/directory.js";
import integrations from "./routes/integrations.js";
import tasks from "./routes/tasks.js";
import pages from "./routes/pages.js";
import mcp from "./routes/mcp.js";

const app = new Hono();

// ── Middleware ──────────────────────────────────────────────────────────────
applyMiddleware(app);

// ── Routes ─────────────────────────────────────────────────────────────────
app.route("/", api);
app.route("/", admin);
app.route("/", directory);
app.route("/", integrations);
app.route("/", tasks);
app.route("/", mcp);
app.route("/", pages); // Pages last — catches remaining paths

// ── Background jobs ────────────────────────────────────────────────────────
setInterval(() => {
  const swept = sweepExpiredRooms();
  cleanOldMetrics();
  if (swept > 0) console.log(`[gc] swept ${swept} expired rooms and stale rate limits`);
}, 60 * 60 * 1000);

setInterval(() => {
  const sent = processScheduledMessages();
  if (sent > 0) console.log(`[scheduler] delivered ${sent} scheduled messages`);
}, 10_000);

// ── Sentinels ──────────────────────────────────────────────────────────────
setTimeout(startSentinels, 3000);

// ── Server ─────────────────────────────────────────────────────────────────
const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
console.log(`[mesh] v${VERSION} starting on port ${port}`);

export default {
  port,
  fetch(req: Request, server: any) {
    // WebSocket upgrade for /ws path
    const wsResponse = handleWsUpgrade(req, server);
    if (wsResponse) return wsResponse;
    // Fall through to Hono for everything else
    return app.fetch(req, { ip: server?.requestIP?.(req) });
  },
  websocket,
};
