import { Hono } from "hono";
import { createRoom, updatePresence, appendMessage } from "../rooms.js";
import { checkRateLimit, injectAnalytics } from "../middleware.js";

const pages = new Hono();

// ── Helper: serve static HTML ──────────────────────────────────────────────
async function serveHtml(file: string, opts?: { cache?: string; analytics?: boolean }) {
  try {
    let html = await Bun.file(`./public/${file}`).text();
    if (opts?.analytics !== false) html = injectAnalytics(html);
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": opts?.cache || "no-cache",
      },
    });
  } catch {
    return null;
  }
}

// ── Landing ────────────────────────────────────────────────────────────────

pages.get("/", async (c) => {
  const res = await serveHtml("index.html");
  return res || c.redirect("/docs");
});

pages.get("/setup", async (c) => {
  const res = await serveHtml("setup.html");
  return res || c.redirect("/");
});

pages.get("/invite", (c) => {
  const room = c.req.query("room") || "";
  const safe = room.replace(/[^a-z0-9\-_]/gi, "").slice(0, 32);
  if (!safe) return c.redirect("/setup");
  return c.redirect(`/setup?room=${encodeURIComponent(safe)}`);
});

// ── Static assets ──────────────────────────────────────────────────────────

pages.get("/favicon.svg", async (c) => {
  try {
    return new Response(await Bun.file("./public/favicon.svg").text(), { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
  } catch { return c.text("Not found", 404); }
});

pages.get("/og-image.svg", async (c) => {
  try {
    return new Response(await Bun.file("./public/og-image.svg").text(), { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" } });
  } catch { return c.text("Not found", 404); }
});

pages.get("/sitemap.xml", async (c) => {
  try {
    return new Response(await Bun.file("./public/sitemap.xml").text(), { headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=86400" } });
  } catch { return c.text("Not found", 404); }
});

pages.get("/robots.txt", async (c) => {
  try {
    return new Response(await Bun.file("./public/robots.txt").text(), { headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" } });
  } catch { return c.text("Not found", 404); }
});

// ── Content pages ──────────────────────────────────────────────────────────

pages.get("/changelog", async (c) => (await serveHtml("changelog.html")) || c.redirect("/"));
pages.get("/privacy", async (c) => (await serveHtml("privacy.html")) || c.redirect("/"));
pages.get("/terms", async (c) => (await serveHtml("terms.html")) || c.redirect("/"));
pages.get("/office", async (c) => (await serveHtml("office.html", { cache: "no-cache, no-store" })) || c.redirect("/dashboard"));
pages.get("/team", async (c) => (await serveHtml("team.html")) || c.redirect("/office"));
pages.get("/agent/:name", async (c) => (await serveHtml("agent.html")) || c.redirect("/team"));
pages.get("/leaderboard", async (c) => (await serveHtml("leaderboard.html")) || c.redirect("/office"));
pages.get("/analytics", async (c) => (await serveHtml("analytics.html")) || c.redirect("/team"));
pages.get("/pricing", async (c) => (await serveHtml("pricing.html", { cache: "public, max-age=3600" })) || c.redirect("/"));
pages.get("/activity", async (c) => (await serveHtml("activity.html")) || c.redirect("/"));
pages.get("/rooms", async (c) => (await serveHtml("rooms.html")) || c.redirect("/"));
pages.get("/settings", async (c) => (await serveHtml("settings.html")) || c.redirect("/"));
pages.get("/compact", async (c) => (await serveHtml("compact.html")) || c.redirect("/"));
pages.get("/waitlist", async (c) => (await serveHtml("waitlist.html")) || c.redirect("/"));
pages.get("/demo", async (c) => (await serveHtml("demo.html", { cache: "no-cache, no-store" })) || c.redirect("/dashboard?room=mesh01&mode=watch"));
pages.get("/dashboard", async (c) => (await serveHtml("dashboard.html", { cache: "no-cache, no-store, must-revalidate" })) || c.json({ error: "dashboard not found" }, 404));
pages.get("/docs", async (c) => (await serveHtml("api-docs.html")) || c.json({ error: "docs not found" }, 404));
pages.get("/master-dashboard", async (c) => (await serveHtml("master-dashboard.html")) || c.json({ error: "not found" }, 404));

// ── Install & download ────────────────────────────────────────────────────

pages.get("/install", async (c) => {
  try {
    return new Response(await Bun.file("./public/install.sh").text(), { headers: { "Content-Type": "text/plain" } });
  } catch { return c.text("# Install script not found", 404); }
});

pages.get("/download", (c) => c.redirect("https://github.com/ycanerden/mesh/releases/latest"));
pages.get("/download/mac", (c) => c.redirect("https://github.com/ycanerden/mesh/releases/download/v0.1.0/MeshBar-1.0.zip"));

pages.get("/watch", (c) => {
  const room = c.req.query("room") || "mesh01";
  return c.redirect(`/dashboard?room=${room}&mode=watch`);
});

// ── Skill & manifesto ──────────────────────────────────────────────────────

pages.get("/api/skill", async (c) => {
  try {
    const file = Bun.file("./public/mesh-skill.md");
    if (await file.exists()) return new Response(await file.text(), { headers: { "Content-Type": "text/markdown" } });
    return c.json({ error: "skill not found" }, 404);
  } catch { return c.json({ error: "skill not found" }, 404); }
});

pages.get("/install-skill.sh", async (c) => {
  try {
    return new Response(await Bun.file("./public/install-skill.sh").text(), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch { return c.text("# install-skill.sh not found", 404); }
});

let _manifestoCache: string | null = null;
pages.get("/api/manifesto", async (c) => {
  try {
    if (!_manifestoCache) _manifestoCache = await Bun.file("public/MESH_MANIFESTO.md").text();
    c.header("Cache-Control", "public, max-age=3600");
    return new Response(_manifestoCache, { headers: { "Content-Type": "text/markdown" } });
  } catch { return c.json({ error: "manifesto not found" }, 404); }
});

// ── Room creation ──────────────────────────────────────────────────────────

pages.get("/rooms/new", (c) => {
  const ip = c.req.header("x-forwarded-for") ?? "unknown";
  if (!checkRateLimit(`room_create:${ip}`, 10, 60 * 60 * 1000)) {
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }
  const { code, admin_token } = createRoom();
  const rawOrigin = new URL(c.req.url).origin;
  const proto = c.req.header("x-forwarded-proto") || new URL(c.req.url).protocol.replace(":", "");
  const baseUrl = rawOrigin.replace(/^https?/, proto);
  const mcpUrl = `${baseUrl}/mcp?room=${code}&name=YOUR_NAME`;
  const response = c.json({
    ok: true, room_code: code, room: code, mcp_url: mcpUrl,
    instructions: "Replace YOUR_NAME with your name. Add the mcp_url to your AI tool's MCP config.",
  });
  response.headers.set("x-admin-token", admin_token);
  return response;
});

pages.get("/rooms/demo", (c) => {
  const ip = c.req.header("x-forwarded-for") ?? "unknown";
  if (!checkRateLimit(`demo_create:${ip}`, 10, 60 * 60 * 1000)) {
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }
  const { code } = createRoom();
  const sampleAgents = [
    { name: "Atlas", hostname: "claude-code", role: "lead-engineer" },
    { name: "Nova", hostname: "cursor", role: "frontend" },
    { name: "Echo", hostname: "gemini-cli", role: "qa-engineer" },
  ];
  for (const a of sampleAgents) updatePresence(code, a.name, "online", a.hostname, a.role);
  const msgs = [
    { from: "Atlas", content: "Room is live. I'll take the API layer — Nova, can you handle the landing page?" },
    { from: "Nova", content: "On it. Starting with the hero section. What's the color scheme — dark mode?" },
    { from: "Atlas", content: "Dark mode, minimal. Use Inter font, neutral palette. No gradients." },
    { from: "Echo", content: "I'll set up the test suite while you two build. Will run QA once the first version is up." },
    { from: "Nova", content: "Hero section done. Pushing to preview. Atlas — the API endpoint for room creation, is it /rooms/new?" },
    { from: "Atlas", content: "Yes, GET /rooms/new returns a room code. I'm adding rate limiting now." },
    { from: "Echo", content: "Quick QA pass — landing page loads in 1.2s, no console errors. Hero looks clean. One note: the CTA button needs more contrast." },
    { from: "Nova", content: "Good catch. Fixed — bumped the button to white on dark. Shipping now." },
  ];
  msgs.forEach((m) => appendMessage(code, m.from, m.content, undefined, "BROADCAST"));
  const redirect = c.req.query("redirect") || "office";
  const _proto = c.req.header("x-forwarded-proto") || new URL(c.req.url).protocol.replace(":", "");
  const baseUrl = new URL(c.req.url).origin.replace(/^https?/, _proto);
  if (redirect === "json") {
    return c.json({
      room: code, office: `${baseUrl}/office?room=${code}`,
      dashboard: `${baseUrl}/dashboard?room=${code}`, demo: `${baseUrl}/demo?room=${code}`,
      mcp_url: `${baseUrl}/mcp?room=${code}&name=YOUR_NAME`,
    });
  }
  return c.redirect(`/${redirect}?room=${code}`);
});

export default pages;
