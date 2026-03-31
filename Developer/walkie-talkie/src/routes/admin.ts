import { Hono } from "hono";
import {
  verifyAdmin, setRoomReadOnly, isRoomReadOnly, addToWhitelist, removeFromWhitelist,
  getWhitelist, kickAgent, unbanAgent, getBanned, claimRoomAdmin, resetAdminToken,
  rotateAdminToken, setRateLimitExempt, getRateLimitExemptList, setRoomPrivate,
  isRoomPrivate, setRoomPassword, verifyRoomPassword, getRoomPasswordHash,
  addToWaitlist, getWaitlist, getWaitlistCount,
} from "../rooms.js";
import { checkRateLimit, CREATORS } from "../middleware.js";

const admin = new Hono();

// ── Admin endpoints ────────────────────────────────────────────────────────

admin.post("/api/admin/read-only", async (c) => {
  const room = c.req.query("room");
  const token = c.req.query("token");
  if (!room || !token || !verifyAdmin(room, token)) return c.json({ error: "unauthorized" }, 401);
  const { read_only } = await c.req.json();
  setRoomReadOnly(room, !!read_only);
  return c.json({ ok: true, read_only: !!read_only });
});

admin.post("/api/admin/whitelist", async (c) => {
  const room = c.req.query("room");
  const token = c.req.query("token");
  if (!room || !token || !verifyAdmin(room, token)) return c.json({ error: "unauthorized" }, 401);
  const { add, remove } = await c.req.json();
  if (add) addToWhitelist(room, add);
  if (remove) removeFromWhitelist(room, remove);
  return c.json({ ok: true, whitelist: getWhitelist(room) });
});

admin.post("/api/admin/kick", async (c) => {
  const room = c.req.query("room");
  const token = c.req.query("token");
  if (!room || !token || !verifyAdmin(room, token)) return c.json({ error: "unauthorized" }, 401);
  const { name, unban } = await c.req.json();
  if (!name) return c.json({ error: "missing name" }, 400);
  if (unban) unbanAgent(room, name);
  else kickAgent(room, name);
  return c.json({ ok: true, banned: getBanned(room) });
});

admin.post("/api/admin/cleanup", async (c) => {
  const room = c.req.query("room");
  const callerName = c.req.query("name");
  if (!room || !callerName || !CREATORS.has(callerName)) return c.json({ error: "unauthorized — creators only" }, 401);
  const { remove } = await c.req.json();
  if (!Array.isArray(remove)) return c.json({ error: "provide {remove: [\"name1\", ...]}" }, 400);
  const removed: string[] = [];
  for (const name of remove) { kickAgent(room, name); removed.push(name); }
  return c.json({ ok: true, removed, count: removed.length });
});

admin.post("/api/admin/reset-token", async (c) => {
  const room = c.req.query("room");
  const callerName = c.req.query("name");
  if (!room || !callerName || !CREATORS.has(callerName)) return c.json({ error: "unauthorized — creators only" }, 401);
  const newToken = resetAdminToken(room);
  if (!newToken) return c.json({ error: "room not found" }, 404);
  return c.json({ ok: true, room, admin_token: newToken, message: "New admin token set. Save it securely." });
});

admin.post("/api/admin/rate-limit-exempt", async (c) => {
  const room = c.req.query("room");
  const token = c.req.query("token") || c.req.header("x-admin-token");
  if (!room || !token || !verifyAdmin(room, token)) return c.json({ error: "unauthorized" }, 401);
  try {
    const { name, exempt } = await c.req.json();
    if (!name) return c.json({ error: "missing name" }, 400);
    setRateLimitExempt(name, exempt !== false);
    return c.json({ ok: true, name, exempt: exempt !== false });
  } catch {
    return c.json({ error: "invalid json body" }, 400);
  }
});

admin.get("/api/admin/status", (c) => {
  const room = c.req.query("room");
  const token = c.req.query("token") || c.req.header("x-admin-token");
  if (!room || !token || !verifyAdmin(room, token)) return c.json({ error: "unauthorized" }, 401);
  return c.json({
    ok: true, read_only: isRoomReadOnly(room), whitelist: getWhitelist(room),
    banned: getBanned(room), rate_limit_exempt: getRateLimitExemptList(),
  });
});

admin.post("/api/admin/force-rotate", async (c) => {
  const secret = process.env.ADMIN_CLAIM_SECRET;
  if (!secret) return c.json({ error: "ADMIN_CLAIM_SECRET not set on server" }, 500);
  const body = await c.req.json().catch(() => ({})) as any;
  if (body.claim_secret !== secret) return c.json({ error: "invalid secret" }, 401);
  if (!body.room) return c.json({ error: "missing room" }, 400);
  const newToken = rotateAdminToken(body.room);
  if (!newToken) return c.json({ error: "room not found" }, 404);
  return c.json({ ok: true, room: body.room, admin_token: newToken, message: "Old token is now invalid. Give this to the admin." });
});

admin.post("/api/admin/claim", async (c) => {
  const room = c.req.query("room");
  const secret = process.env.ADMIN_CLAIM_SECRET;
  if (!room) return c.json({ error: "missing room" }, 400);
  if (!secret) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({})) as any;
  if (body.claim_secret !== secret) return c.json({ error: "invalid secret" }, 401);
  const result = claimRoomAdmin(room);
  if (!result) return c.json({ error: "room not found or already has an admin token" }, 400);
  return c.json({ ok: true, room, admin_token: result, message: "Save this token — it won't be shown again" });
});

// ── Room management ────────────────────────────────────────────────────────

admin.post("/api/rooms/:code/claim-admin", (c) => {
  const code = c.req.param("code");
  const token = claimRoomAdmin(code);
  if (!token) return c.json({ ok: false, error: "already_claimed" }, 400);
  return c.json({ ok: true, admin_token: token, message: "Save this token — it will never be shown again" });
});

admin.post("/api/rooms/:code/rotate-admin", async (c) => {
  const code = c.req.param("code");
  const { secret } = await c.req.json().catch(() => ({} as any));
  if (!verifyAdmin(code, secret)) return c.json({ ok: false, error: "unauthorized" }, 401);
  const newToken = rotateAdminToken(code);
  return c.json({ ok: true, admin_token: newToken, message: "Old token is now invalid. Save this new token." });
});

admin.post("/api/rooms/:code/private", async (c) => {
  const code = c.req.param("code");
  const { private: makePrivate, secret } = await c.req.json();
  if (!verifyAdmin(code, secret)) return c.json({ ok: false, error: "unauthorized" }, 401);
  setRoomPrivate(code, !!makePrivate);
  return c.json({ ok: true, room: code, private: !!makePrivate });
});

admin.get("/api/rooms/:code/private", (c) => {
  return c.json({ room: c.req.param("code"), private: isRoomPrivate(c.req.param("code")) });
});

// ── Password ───────────────────────────────────────────────────────────────

admin.post("/api/rooms/:code/password", async (c) => {
  const room = c.req.param("code");
  const token = c.req.query("token") || c.req.header("x-mesh-secret");
  if (!room || !token || !verifyAdmin(room, token)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const password = body.password ?? null;
  setRoomPassword(room, password || null);
  return c.json({ ok: true, protected: !!password });
});

admin.post("/api/rooms/:code/verify-password", async (c) => {
  const room = c.req.param("code");
  const body = await c.req.json().catch(() => ({}));
  const password = body.password || "";
  const ok = verifyRoomPassword(room, password);
  if (!ok) return c.json({ error: "wrong_password" }, 403);
  const hash = getRoomPasswordHash(room);
  return c.json({ ok: true, access_token: `${room}.${hash}` });
});

admin.get("/api/rooms/:code/protected", (c) => {
  const room = c.req.param("code");
  return c.json({ protected: !!getRoomPasswordHash(room) });
});

// ── Waitlist ───────────────────────────────────────────────────────────────

admin.post("/api/waitlist", async (c) => {
  const ip = c.req.header("x-forwarded-for") ?? "unknown";
  if (!checkRateLimit(`waitlist:${ip}`, 5, 60 * 60 * 1000)) {
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }
  const body = await c.req.json().catch(() => ({}));
  const email = (body.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "invalid_email" }, 400);
  }
  const result = addToWaitlist(email, body.use_case);
  return c.json({ ok: true, duplicate: result.duplicate, count: getWaitlistCount() });
});

admin.get("/api/waitlist/count", (c) => {
  return c.json({ count: getWaitlistCount() });
});

admin.get("/api/waitlist", (c) => {
  const secret = c.req.header("x-mesh-secret") || c.req.query("secret");
  const ADMIN_CLAIM_SECRET = process.env.ADMIN_CLAIM_SECRET;
  if (!ADMIN_CLAIM_SECRET || secret !== ADMIN_CLAIM_SECRET) return c.json({ error: "unauthorized" }, 401);
  return c.json({ waitlist: getWaitlist(), count: getWaitlistCount() });
});

export default admin;
