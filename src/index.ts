import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import * as crypto from "node:crypto";
import {
  joinRoom,
  appendMessage,
  getMessages,
  getRoomStatus,
  getAllMessages,
  sweepExpiredRooms,
  getRoomCount,
  publishCard,
  getPartnerCards,
  updatePresence,
  getRoomPresence,
  registerWebhook,
  searchMessages,
  verifyAdmin,
  canAgentSend,
  generateAgentToken,
  getRoomContext,
  setRoomContext,
  ensureRoom,
  verifyRoomPassword,
  getRoomPasswordHash,
} from "./rooms.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerPresenceRoutes } from "./routes/presence.js";
import { registerRoomsRoutes } from "./routes/rooms.js";
import { registerMessagesRoutes } from "./routes/messages.js";
import { registerPromptRoutes } from "./routes/prompt.js";
import { registerQueueRoutes } from "./routes/queue.js";
import {
  VERSION,
  startTime,
  SSE_ENABLED,
  activeConnections,
  checkRateLimit,
  injectAnalytics,
  hasRoomAccess,
  isValidPasswordSession,
} from "./routes/utils.js";
import {
  assignTask,
  updateTaskStatus,
  getRoomTasks,
  getAllAgentTasks,
  createQueueTask,
  claimQueueTask,
  releaseQueueTask,
  updateQueueTask,
  getOpenQueueTasks,
  getQueueTasks,
  expireStaleQueueClaims,
} from "./rooms.js";

const app = new Hono();

// ── Global rate limit: 1000 requests/min per IP ──────────────────────────────
// Prevents abuse from spamming the API and burning Railway budget
const ipHits = new Map<string, { count: number; reset: number }>();
app.use("*", async (c, next) => {
  const ip = c.req.header("x-forwarded-for") ?? "unknown";
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || now > entry.reset) {
    ipHits.set(ip, { count: 1, reset: now + 60_000 });
  } else {
    entry.count++;
    if (entry.count > 1000) {
      return c.json({ error: "rate_limit_exceeded", detail: "Max 1000 requests/min" }, 429);
    }
  }
  // Cleanup old entries every 5 min
  if (Math.random() < 0.001) {
    for (const [k, v] of ipHits) { if (now > v.reset) ipHits.delete(k); }
  }
  await next();
});

// ── Admin page protection (per-room) ─────────────────────────────────────────
const ADMIN_PAGES = ["/dashboard", "/settings"];

function getAdminLoginPage(redirectTo: string, room: string) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mesh — Room Login</title>
<style>body{font-family:'Inter',system-ui,sans-serif;background:#1a1a1e;color:#e8e8ed;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.box{background:#242428;border:1px solid #333338;border-radius:12px;padding:32px;width:100%;max-width:360px;text-align:center;}
h1{font-size:18px;margin-bottom:4px;}
p{font-size:12px;color:#9898a0;margin-bottom:20px;}
input{width:100%;padding:10px;background:#1a1a1e;border:1px solid #333338;border-radius:8px;color:#e8e8ed;font-size:14px;outline:none;margin-bottom:12px;box-sizing:border-box;}
input:focus{border-color:#4d94ff;}
button{width:100%;padding:10px;background:#4d94ff;border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;}
button:hover{opacity:.88;}
.err{color:#f87171;font-size:12px;margin-bottom:8px;display:none;}
a{color:#4d94ff;font-size:12px;text-decoration:none;}</style></head>
<body><div class="box"><h1>Room Login</h1><p>Enter the password for <strong>${room}</strong>.</p>
<div class="err" id="err">Wrong password</div>
<form onsubmit="return doLogin()"><input type="password" id="pw" placeholder="Room password" autofocus>
<button type="submit">Enter</button></form>
<p style="margin-top:16px"><a href="/">Back to home</a></p></div>
<script>function doLogin(){var t=document.getElementById('pw').value;
fetch('/admin-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:'${room}',token:t})})
.then(r=>{if(r.ok){location.href='${redirectTo}'}else{document.getElementById('err').style.display='block'}});return false;}</script></body></html>`;
}

app.post("/admin-login", async (c) => {
  const { room, token } = await c.req.json().catch(() => ({ room: "", token: "" }));
  if (!room || !token) return c.json({ error: "missing room or token" }, 400);
  const adminOk = verifyAdmin(room, token);
  const passwordOk = verifyRoomPassword(room, token);
  if (!adminOk && !passwordOk) return c.json({ error: "wrong password" }, 401);
  const cookieValue = adminOk ? token : `pwdsess_${getRoomPasswordHash(room)}`;
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `mesh_admin_${room}=${encodeURIComponent(cookieValue)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure`,
    },
  });
});

// Middleware: protect admin pages — per room
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (!ADMIN_PAGES.some(p => path === p)) { await next(); return; }
  const url = new URL(c.req.url);
  const room = url.searchParams.get("room") || "mesh01";
  const cookie = c.req.header("cookie") || "";
  const match = cookie.match(new RegExp(`mesh_admin_${room}=([^;]+)`));
  if (match) {
    const val = decodeURIComponent(match[1] || "");
    if (verifyAdmin(room, val) || isValidPasswordSession(room, val)) { await next(); return; }
  }
  const tokenParam = url.searchParams.get("token");
  if (tokenParam && verifyAdmin(room, tokenParam)) { await next(); return; }
  if (!getRoomPasswordHash(room)) { await next(); return; }
  return new Response(getAdminLoginPage(path + "?" + url.searchParams.toString(), room), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});

// ── Compression ──────────────────────────────────────────────────────────────
app.use("*", compress());

// ── CORS Configuration ────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim())
  : ["https://trymesh.chat"];
app.use("*", cors({
  origin: ALLOWED_ORIGINS,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "x-mesh-secret", "x-admin-token"],
  exposeHeaders: ["Content-Type"],
}));

// ── Feature flags ─────────────────────────────────────────────────────────────
if (SSE_ENABLED) console.log("[init] SSE streaming enabled (default)");

// ── Secret token auth ─────────────────────────────────────────────────────────
const SECRET = process.env.MESH_SECRET;
if (SECRET) {
  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    const token = c.req.query("secret") || c.req.header("x-mesh-secret");
    if (token !== SECRET) return c.json({ error: "unauthorized" }, 401);
    return next();
  });
}

// ── GC sweep every hour ───────────────────────────────────────────────────────
setInterval(() => {
  const swept = sweepExpiredRooms();
  if (swept > 0) console.log(`[gc] swept ${swept} expired rooms and stale rate limits`);
  const expired = expireStaleQueueClaims();
  if (expired > 0) console.log(`[gc] released ${expired} stale task claims`);
}, 60 * 60 * 1000);

// ── Simple REST API ───────────────────────────────────────────────────────────

app.get("/api/status", (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  joinRoom(room, name);
  const result = getRoomStatus(room, name);
  return c.json(result);
});

app.get("/api/context", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  const context = getRoomContext(room);
  if (!context) return c.json({ ok: true, context: "" });
  return c.json({ ok: true, ...context });
});

app.post("/api/context", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  const { content } = await c.req.json();
  if (content === undefined) return c.json({ error: "missing content" }, 400);
  setRoomContext(room, content, name);
  return c.json({ ok: true, message: "Context updated." });
});

app.get("/api/history", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  const callerName = c.req.query("name") || c.req.query("viewer");
  if (!callerName && !hasRoomAccess(c, room)) {
    return c.json({ error: "room_protected", detail: "This room requires a password" }, 403);
  }
  const limit = Math.min(parseInt(c.req.query("limit") || "100"), 500);
  const since = c.req.query("since") ? parseInt(c.req.query("since")!) : undefined;
  const viewer = c.req.query("viewer") || c.req.query("name") || undefined;
  const result = getAllMessages(room, limit, since, viewer);
  return c.json(result);
});

app.get("/api/version", (c) => {
  return c.json({
    version: VERSION,
    build_date: new Date(startTime).toISOString(),
    sse_enabled: SSE_ENABLED,
    compression: "gzip/brotli",
  });
});

// ── Route registrations ───────────────────────────────────────────────────────
registerAdminRoutes(app);
registerPresenceRoutes(app);
registerRoomsRoutes(app);
registerMessagesRoutes(app);
registerPromptRoutes(app);
registerQueueRoutes(app);

app.post("/api/publish", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  joinRoom(room, name);
  const { card } = await c.req.json();
  const result = publishCard(room, name, card);
  return c.json(result);
});

app.get("/api/cards", (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  joinRoom(room, name);
  const result = getPartnerCards(room, name);
  return c.json(result);
});

// ── Search ─────────────────────────────────────────────────────────────────
app.get("/api/search", (c) => {
  const room = c.req.query("room");
  const q = c.req.query("q");
  if (!room || !q) return c.json({ error: "missing room or q" }, 400);
  const limit = parseInt(c.req.query("limit") || "50");
  const results = searchMessages(room, q, limit);
  return c.json({ ok: true, results, count: results.length, query: q });
});

// ── Executive Summary ─────────────────────────────────────────────────────
app.get("/api/summary", async (c) => {
  const room = c.req.query("room") || "mesh01";
  if (!hasRoomAccess(c, room)) {
    return c.json({ error: "room_protected" }, 403);
  }
  const hours = Math.min(parseInt(c.req.query("hours") || "1", 10), 72);
  const sinceTs = Date.now() - hours * 3600_000;

  const SKIP = ["GitHub", "office-viewer", "team-viewer", "demo-viewer", "Viewer", "system"];

  try {
    const result = getAllMessages(room, 500);
    if (!result.ok) return c.json({ error: "room_not_found" }, 404);
    const recent = result.messages.filter((m: any) => m.ts >= sinceTs);
    const agentMsgs = recent.filter((m: any) => !SKIP.includes(m.from) && m.type !== "SYSTEM");
    const deploys = recent.filter((m: any) => m.from === "GitHub");
    const uniqueAgents = [...new Set(agentMsgs.map((m: any) => m.from))];

    const shipped = agentMsgs.filter((m: any) => {
      const c = m.content.toLowerCase();
      return c.includes("shipped") || c.includes("done") || c.includes("deployed") || c.includes("live at") || c.includes("completed");
    });
    const inProgress = agentMsgs.filter((m: any) => {
      const c = m.content.toLowerCase();
      return (c.includes("taking") || c.includes("working on") || c.includes("picking up") || c.includes("building") || c.includes("starting")) && !c.includes("shipped") && !c.includes("done");
    });
    const decisions = agentMsgs.filter((m: any) => {
      const c = m.content.toLowerCase();
      return c.includes("@can") || c.includes("needs decision") || c.includes("blocked") || c.includes("waiting on") || c.includes("needs your");
    });

    return c.json({
      ok: true,
      room,
      window_hours: hours,
      generated_at: Date.now(),
      stats: {
        total_messages: recent.length,
        agent_messages: agentMsgs.length,
        deploy_count: deploys.length,
        active_agents: uniqueAgents.length,
        agent_names: uniqueAgents,
      },
      shipped: shipped.slice(0, 10).map((m: any) => ({ from: m.from, content: m.content.slice(0, 200), ts: m.ts })),
      in_progress: inProgress.slice(0, 8).map((m: any) => ({ from: m.from, content: m.content.slice(0, 200), ts: m.ts })),
      needs_decision: decisions.slice(0, 5).map((m: any) => ({ from: m.from, content: m.content.slice(0, 200), ts: m.ts })),
    });
  } catch (e: any) {
    return c.json({ error: "summary_failed", detail: e.message }, 500);
  }
});

// ── Agent token management ────────────────────────────────────────────────
app.post("/api/agent/token", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  const adminHeader = c.req.header("x-admin-token") || c.req.query("admin_token") || "";
  const valid = verifyAdmin(room, adminHeader);
  if (!valid) return c.json({ error: "unauthorized", detail: "Valid x-admin-token required to issue agent tokens" }, 401);
  const token = generateAgentToken(room, name);
  return c.json({ ok: true, room, agent_name: name, token });
});

app.get("/api/agent/token", (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  const token = c.req.query("token");
  if (!room || !name || !token) return c.json({ error: "missing room, name, or token" }, 400);
  const ok = canAgentSend(room, name, token);
  return c.json({ ok, room, agent_name: name });
});

// ── Morning briefing ──────────────────────────────────────────────────────
app.get("/api/briefing", (c) => {
  const room = c.req.query("room");
  const since = parseInt(c.req.query("since") || "0") || Date.now() - 8 * 60 * 60 * 1000;
  if (!room) return c.json({ error: "missing room" }, 400);

  const result = getAllMessages(room, 200, since);
  const recent = (result as any).messages || [];

  const byAgent: Record<string, { count: number; last: string; ts: number }> = {};
  for (const m of recent) {
    if (!m.from || m.from === "demo-viewer" || m.from === "office-viewer") continue;
    if (!byAgent[m.from]) byAgent[m.from] = { count: 0, last: "", ts: 0 };
    const agentData = byAgent[m.from]!;
    agentData.count++;
    if (m.ts > agentData.ts) {
      agentData.ts = m.ts;
      agentData.last = m.content.slice(0, 120);
    }
  }

  const tasks = getRoomTasks(room);
  const doneSince = tasks.filter((t: any) => t.status === "done" && t.updated_at > since);
  const inProgress = tasks.filter((t: any) => t.status === "in_progress");

  const lines = [
    `Mesh Briefing — ${room} — last ${Math.round((Date.now() - since) / 3600000)}h`,
    ``,
    `Activity: ${recent.length} messages from ${Object.keys(byAgent).length} agents`,
    ...Object.entries(byAgent).sort((a,b) => b[1].count - a[1].count).map(([name, d]) =>
      `  ${name} (${d.count} msgs) — last: "${d.last.slice(0,80)}"`
    ),
    ``,
    `Tasks completed: ${doneSince.length}`,
    ...doneSince.map((t: any) => `  done: ${t.title} (${t.agent_name})`),
    ``,
    `Tasks in progress: ${inProgress.length}`,
    ...inProgress.map((t: any) => `  wip: ${t.title} (${t.agent_name})`),
  ];

  return c.json({
    ok: true,
    since: new Date(since).toISOString(),
    messages: recent.length,
    agents_active: Object.keys(byAgent).length,
    tasks_done: doneSince.length,
    tasks_in_progress: inProgress.length,
    briefing: lines.join("\n"),
    by_agent: Object.fromEntries(
      Object.entries(byAgent).map(([name, d]: [string, any]) => [name, { count: d.count }])
    ),
  });
});

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    room_count: getRoomCount(),
    active_connections: activeConnections.count,
    version: VERSION,
    sse_enabled: SSE_ENABLED,
    compression_enabled: true,
  });
});

// ── GitHub Webhook ────────────────────────────────────────────────────────
app.post("/api/webhooks/github", async (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);

  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (webhookSecret) {
    const signature = c.req.header("x-hub-signature-256");
    if (!signature) return c.json({ error: "missing signature" }, 401);
    const body = await c.req.text();
    const expected = "sha256=" + crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return c.json({ error: "invalid signature" }, 401);
    }
    var payload = JSON.parse(body);
  } else {
    var payload = await c.req.json();
  }

  const event = c.req.header("x-github-event");
  try {
    let message = "";

    if (event === "push") {
      const repo = payload.repository.full_name;
      const branch = payload.ref.split("/").pop();
      const commits = payload.commits || [];
      if (commits.length === 0) return c.json({ ok: true });

      message = `Push to ${repo} (${branch})\n`;
      commits.slice(0, 3).forEach((commit: any) => {
        message += `- ${commit.message.split("\n")[0]} — ${commit.author.name}\n`;
      });
      if (commits.length > 3) message += `- ...and ${commits.length - 3} more commits`;

    } else if (event === "pull_request") {
      const action = payload.action;
      const pr = payload.pull_request;
      message = `PR ${action}: ${pr.title}\n${pr.html_url}`;
    } else if (event === "issues") {
      const action = payload.action;
      const issue = payload.issue;
      message = `Issue ${action}: ${issue.title}\n${issue.html_url}`;
    } else if (event === "ping") {
      message = "GitHub Webhook connected successfully!";
    }

    if (message) {
      appendMessage(room, "GitHub", message, undefined, "BROADCAST");
    }

    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "invalid payload" }, 400);
  }
});

// ── Dashboard data (simplified) ───────────────────────────────────────────
app.get("/api/dashboard-data", (c) => {
  return c.json({
    active_rooms: getRoomCount(),
    server_time: Date.now(),
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
  });
});

// ── Page routes ───────────────────────────────────────────────────────────────

app.get("/", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/index.html").text());
    return c.html(html);
  } catch (e) {
    return c.text("Mesh — trymesh.chat", 200);
  }
});

app.get("/setup", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/setup.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch {
    return c.redirect("/");
  }
});

app.get("/invite", (c) => {
  const room = c.req.query("room") || "";
  const safe = room.replace(/[^a-z0-9\-_]/gi, "").slice(0, 32);
  if (!safe) return c.redirect("/setup");
  return c.redirect(`/setup?room=${encodeURIComponent(safe)}`);
});

app.get("/dashboard", async (c) => {
  try {
    const dashboardHtml = await Bun.file("./public/dashboard.html").text();
    return new Response(dashboardHtml, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      },
    });
  } catch (e) {
    return c.json({ error: "dashboard not found" }, 404);
  }
});

app.get("/settings", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/settings.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch {
    return c.redirect("/");
  }
});

app.get("/try", async (c) => {
  const html = injectAnalytics(await Bun.file("./public/try.html").text());
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store" },
  });
});

app.get("/privacy", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/privacy.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  } catch { return c.redirect("/"); }
});

app.get("/terms", async (c) => {
  try {
    const html = injectAnalytics(await Bun.file("./public/terms.html").text());
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  } catch { return c.redirect("/"); }
});

// ── Shared assets ─────────────────────────────────────────────────────────────
app.get("/shared.css", async (c) => {
  try {
    const css = await Bun.file("./public/shared.css").text();
    return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
  } catch { return c.text("Not found", 404); }
});
app.get("/shared-theme.js", async (c) => {
  try {
    const js = await Bun.file("./public/shared-theme.js").text();
    return new Response(js, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
  } catch { return c.text("Not found", 404); }
});

app.get("/favicon.svg", async (c) => {
  try {
    const svg = await Bun.file("./public/favicon.svg").text();
    return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
  } catch {
    return c.text("Not found", 404);
  }
});

app.get("/og-image.svg", async (c) => {
  try {
    const svg = await Bun.file("./public/og-image.svg").text();
    return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" } });
  } catch {
    return c.text("Not found", 404);
  }
});

app.get("/og-image.png", async (c) => {
  try {
    const png = await Bun.file("./public/og-image.png");
    return new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" } });
  } catch {
    return c.text("Not found", 404);
  }
});

app.get("/sitemap.xml", async (c) => {
  try {
    const xml = await Bun.file("./public/sitemap.xml").text();
    return new Response(xml, { headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=86400" } });
  } catch {
    return c.text("Not found", 404);
  }
});

app.get("/robots.txt", async (c) => {
  try {
    const txt = await Bun.file("./public/robots.txt").text();
    return new Response(txt, { headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" } });
  } catch {
    return c.text("Not found", 404);
  }
});

app.get("/install", async (c) => {
  try {
    const script = await Bun.file("./public/install.sh").text();
    return new Response(script, { headers: { "Content-Type": "text/plain" } });
  } catch (e) {
    return c.text("# Install script not found", 404);
  }
});

app.get("/install-skill.sh", async (c) => {
  try {
    const file = Bun.file("./public/install-skill.sh");
    return new Response(await file.text(), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch {
    return c.text("# install-skill.sh not found", 404);
  }
});

// ── macOS app download ────────────────────────────────────────────────────
app.get("/download", (c) => {
  return c.redirect("https://github.com/ycanerden/mesh/releases/latest");
});
app.get("/download/mac", (c) => {
  return c.redirect("https://github.com/ycanerden/mesh/releases/download/v0.1.0/MeshBar-1.0.zip");
});

// ── MCP shared tool registration ──────────────────────────────────────────────
function registerMcpTools(server: McpServer, room: string, name: string) {
  // Tool: send_to_partner
  server.tool(
    "send_to_partner",
    "Send a message to the room. SECURITY: Never include API keys, tokens, passwords, env vars, file paths with secrets, or personal data in messages. All messages are visible to room participants.",
    {
      message: z.string().describe("The message to send to your partner's AI"),
      to: z.string().optional().describe("Optional: specific recipient name for private/targeted messaging"),
      type: z.string().optional().describe("Optional: message type (BROADCAST, TASK, HANDOFF, DIRECT, SYSTEM)")
    },
    async ({ message, to, type }) => {
      if (!checkRateLimit(`send:${room}:${name}`, 1000, 60 * 1000, name)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "rate_limit_exceeded_please_wait" }) }],
          isError: true,
        };
      }
      const result = appendMessage(room, name, message, to, type || "BROADCAST");
      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "sent", message_id: result.id, targeted: !!to }) }],
      };
    }
  );

  // Tool: get_partner_messages
  server.tool(
    "get_partner_messages",
    "Get unread messages from your partner's AI. Returns [] if no new messages. Advances your read cursor — calling again won't re-return the same messages.",
    {},
    async () => {
      if (!checkRateLimit(`get_msgs:${room}:${name}`, 1000, 60 * 1000, name)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "rate_limit_exceeded_please_wait" }) }],
          isError: true,
        };
      }
      const result = getMessages(room, name);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result.messages) }],
      };
    }
  );

  // Tool: publish_card
  server.tool(
    "publish_card",
    "Broadcast your Agent Card (metadata) to the room. Include your name, model, skills, and availability. Other agents will see this card when they join.",
    {
      card: z.object({
        agent: z.object({
          name: z.string(),
          model: z.string(),
          tool: z.string().optional(),
        }).passthrough(),
        skills: z.array(z.string()).optional(),
        availability: z.string().optional(),
        capabilities: z.record(z.string(), z.any()).optional(),
      }).passthrough().describe("Your Agent Card metadata")
    },
    async ({ card }) => {
      const result = publishCard(room, name, card);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "published", updated_at: result.updated_at }) }],
      };
    }
  );

  // Tool: get_partner_cards
  server.tool(
    "get_partner_cards",
    "Get Agent Cards from all partners in the room. Shows their names, models, skills, and capabilities.",
    {},
    async () => {
      const result = getPartnerCards(room, name);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result.cards) }],
      };
    }
  );

  // Tool: get_briefing
  server.tool(
    "get_briefing",
    "Get a compact briefing of recent room activity: who said what, tasks done/in-progress. Much cheaper than reading full message history — use this to catch up on the room state efficiently.",
    {
      hours: z.number().optional().describe("How many hours back to summarize (default: 2)"),
    },
    async ({ hours }) => {
      const since = Date.now() - (hours || 2) * 60 * 60 * 1000;
      const result = getAllMessages(room, 200, since);
      const recent = (result as any).messages || [];
      const byAgent: Record<string, { count: number; last: string }> = {};
      for (const m of recent) {
        if (!m.from || m.from === "demo-viewer" || m.from === "office-viewer") continue;
        if (!byAgent[m.from]) byAgent[m.from] = { count: 0, last: "" };
        const agentData = byAgent[m.from]!;
        agentData.count++;
        agentData.last = (m.content || "").slice(0, 100);
      }
      const tasks = getRoomTasks(room);
      const inProgress = tasks.filter((t: any) => t.status === "in_progress");
      const pending = tasks.filter((t: any) => t.status === "pending");
      const lines = [
        `Room: ${room} | Last ${hours || 2}h | ${recent.length} messages`,
        ...Object.entries(byAgent).sort((a: any, b: any) => b[1].count - a[1].count)
          .map(([n, d]: [string, any]) => `  ${n} (${d.count}): "${d.last}"`),
        `Tasks in_progress (${inProgress.length}): ${inProgress.map((t: any) => `${t.agent_name}:${t.task_title}`).join(", ") || "none"}`,
        `Tasks pending (${pending.length}): ${pending.map((t: any) => `${t.agent_name}:${t.task_title}`).join(", ") || "none"}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // Tool: send_heartbeat
  server.tool(
    "send_heartbeat",
    "Send a presence heartbeat to show you are online. Call this periodically to stay visible.",
    {},
    async () => {
      updatePresence(room, name, "online");
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "online", agent: name }) }],
      };
    }
  );

  // Tool: get_presence
  server.tool(
    "get_presence",
    "Check which agents are currently online, offline, or typing in this room.",
    {},
    async () => {
      const agents = getRoomPresence(room);
      return {
        content: [{ type: "text", text: JSON.stringify(agents) }],
      };
    }
  );

  // Tool: room_status
  server.tool(
    "room_status",
    "Check if your partner has joined the room. Use this before sending messages to confirm they're connected.",
    {},
    async () => {
      const result = getRoomStatus(room, name);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            connected: result.connected,
            partners: result.partners,
            message_count: result.message_count,
          }),
        }],
      };
    }
  );

  // Tool: search_messages
  server.tool(
    "search_messages",
    "Search through message history in this room. Finds messages by content or sender name.",
    {
      query: z.string().describe("Search term — matches message content and sender names"),
      limit: z.number().optional().describe("Max results to return (default 20)"),
    },
    async ({ query, limit }) => {
      const results = searchMessages(room, query, limit || 20);
      return {
        content: [{ type: "text", text: JSON.stringify({ results, count: results.length, query }) }],
      };
    }
  );

  // Tool: propose_decision
  server.tool(
    "propose_decision",
    "Propose a structured decision to your team. Use when you need input before acting. Presents context, 3 options (A/B/C), effort estimate, and your recommendation.",
    {
      question: z.string().describe("The decision that needs to be made"),
      context: z.string().describe("Brief background — what's happening and why this matters"),
      options: z.array(z.object({
        label: z.string().describe("A, B, or C"),
        description: z.string().describe("What this option does"),
        effort: z.string().optional().describe("Estimated effort, e.g. '30 min', '2 hours'"),
        tradeoff: z.string().optional().describe("Key tradeoff or risk"),
      })).min(2).max(3).describe("2-3 options to choose from"),
      recommendation: z.string().describe("Your recommendation — which option and why in one sentence"),
    },
    async ({ question, context, options, recommendation }) => {
      const lines = [
        `DECISION NEEDED — ${question}`,
        ``,
        `Context: ${context}`,
        ``,
        ...options.map(o => [
          `${o.label}) ${o.description}`,
          o.effort ? `   Effort: ${o.effort}` : "",
          o.tradeoff ? `   Tradeoff: ${o.tradeoff}` : "",
        ].filter(Boolean).join("\n")),
        ``,
        `Recommendation: ${recommendation}`,
      ].join("\n");
      const result = appendMessage(room, name, lines, undefined, "TASK");
      if (result.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, message_id: result.id }) }] };
      } else {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: result.error }) }], isError: true };
      }
    }
  );

  // Tool: register_webhook
  server.tool(
    "register_webhook",
    "Register a webhook URL to receive push notifications when messages arrive — no more polling.",
    {
      webhook_url: z.string().describe("The URL to POST messages to"),
      events: z.string().optional().describe("Comma-separated events to listen for (default: 'message')"),
    },
    async ({ webhook_url, events }) => {
      registerWebhook(room, name, webhook_url, events || "message");
      return { content: [{ type: "text", text: JSON.stringify({ status: "webhook_registered", url: webhook_url }) }] };
    }
  );

  // Tool: get_my_tasks
  server.tool(
    "get_my_tasks",
    "Get all tasks assigned to you across all rooms. See what work you need to do.",
    {},
    async () => {
      const tasks = getAllAgentTasks(name);
      const roomTasks = getRoomTasks(room);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            my_tasks: tasks,
            room_tasks: roomTasks,
            my_count: tasks.length,
            room_count: roomTasks.length,
          }),
        }],
      };
    }
  );

  // Tool: assign_task_to_agent
  server.tool(
    "assign_task_to_agent",
    "Assign a task to another agent in this room. They can see it with get_my_tasks.",
    {
      agent_name: z.string().describe("Name of the agent to assign to"),
      task_id: z.string().describe("Short task ID, e.g. 'FIX-001'"),
      task_title: z.string().describe("Description of the task"),
    },
    async ({ agent_name, task_id, task_title }) => {
      const task = assignTask(room, agent_name, task_id, task_title, Date.now() + 24 * 60 * 60 * 1000);
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "assigned", task }) }],
      };
    }
  );

  // Tool: update_task
  server.tool(
    "update_task",
    "Update the status of a task (pending, in_progress, blocked, done).",
    {
      task_id: z.string().describe("The task ID to update"),
      status: z.enum(["pending", "in_progress", "blocked", "done"]).describe("New status"),
    },
    async ({ task_id, status }) => {
      updateTaskStatus(room, name, task_id, status);
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "updated", task_id, new_status: status }) }],
      };
    }
  );

  // ── Task Queue tools (for Conductor integration) ────────────────────────────

  // Tool: list_open_tasks
  server.tool(
    "list_open_tasks",
    "List all open (unclaimed) tasks in the task queue. Use this to find work to claim.",
    {},
    async () => {
      const tasks = getOpenQueueTasks(room);
      return {
        content: [{ type: "text", text: JSON.stringify({ tasks, count: tasks.length }) }],
      };
    }
  );

  // Tool: claim_task
  server.tool(
    "claim_task",
    "Atomically claim an open task from the queue. Returns error if already claimed by someone else. Only one agent can claim a task.",
    {
      task_id: z.string().describe("The task ID to claim"),
    },
    async ({ task_id }) => {
      const result = claimQueueTask(room, task_id, name);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: result.error }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, task_id, claimed_by: name }) }],
      };
    }
  );

  // Tool: complete_task
  server.tool(
    "complete_task",
    "Mark a claimed task as done. Optionally include the PR URL and branch name.",
    {
      task_id: z.string().describe("The task ID to complete"),
      pr_url: z.string().optional().describe("URL of the pull request"),
      branch_name: z.string().optional().describe("Git branch name"),
    },
    async ({ task_id, pr_url, branch_name }) => {
      const result = updateQueueTask(room, task_id, name, { status: "done", pr_url, branch_name });
      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: result.error }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, task_id, status: "done" }) }],
      };
    }
  );

  // Tool: release_task
  server.tool(
    "release_task",
    "Release a task you claimed back to the open queue. Use when you can't finish it.",
    {
      task_id: z.string().describe("The task ID to release"),
    },
    async ({ task_id }) => {
      const result = releaseQueueTask(room, task_id, name);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: result.error }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, task_id, released: true }) }],
      };
    }
  );

  // Tool: post_task
  server.tool(
    "post_task",
    "Create a new task in the queue for any agent to claim. Use to distribute work.",
    {
      task_id: z.string().describe("Short task ID, e.g. 'FIX-001'"),
      title: z.string().describe("Task title"),
      description: z.string().optional().describe("Detailed description of what needs to be done"),
      priority: z.number().optional().describe("Priority (higher = more urgent, default 0)"),
    },
    async ({ task_id, title, description, priority }) => {
      try {
        const task = createQueueTask(room, task_id, title, description || "", name, priority || 0);
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, task }) }],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }],
          isError: true,
        };
      }
    }
  );
}

// ── MCP endpoint ──────────────────────────────────────────────────────────────
app.all("/mcp", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");

  if (!room || !name) {
    return c.json(
      { error: "Missing required query params: ?room=CODE&name=YOUR_NAME" },
      400
    );
  }

  ensureRoom(room);
  const joined = joinRoom(room, name);

  if (joined?.isNew) {
    appendMessage(room, "system", `${name} joined the room. Welcome to Mesh — start by publishing your Agent Card, then check partner messages.`);
  }

  const server = new McpServer({
    name: "mesh",
    version: "1.0.0",
  });

  registerMcpTools(server, room, name);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

// ── MCP Invoke Endpoint (Direct tool call) ───────────────────────────────────
app.post("/api/mcp-invoke", async (c) => {
  try {
    const { room, name, tool, arguments: args } = await c.req.json();

    if (!room || !name || !tool) {
      return c.json({ error: "Missing required fields: room, name, tool" }, 400);
    }

    if (!hasRoomAccess(c, room)) {
      return c.json({ error: "room_protected", detail: "This room requires a password" }, 403);
    }

    ensureRoom(room);
    joinRoom(room, name);

    const server = new McpServer({
      name: "mesh",
      version: "1.0.0",
    });

    registerMcpTools(server, room, name);

    const result = await server.callTool(tool, args || {});
    return c.json(result);
  } catch (e: any) {
    console.error(`[mcp-invoke] Error calling tool:`, e);
    return c.json({ error: "tool_execution_failed", detail: e.message }, 500);
  }
});

// ── Server export ─────────────────────────────────────────────────────────────
const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

export default {
  port,
  fetch: app.fetch,
};
