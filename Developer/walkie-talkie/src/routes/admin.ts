import type { Hono } from "hono";
import {
  verifyAdmin,
  setRoomReadOnly,
  isRoomReadOnly,
  addToWhitelist,
  removeFromWhitelist,
  getWhitelist,
  kickAgent,
  unbanAgent,
  getBanned,
  resetAdminToken,
  claimRoomAdmin,
  setRateLimitExempt,
  getRateLimitExemptList,
  rotateAdminToken,
} from "../rooms.js";

// Known creators — always get "creator" role regardless of heartbeat body
export const CREATORS = new Set(
  (process.env.MESH_CREATORS || "Can Erden,Vincent,gimli")
    .split(",")
    .map((s) => s.trim())
);

// Creator admin secret — required for creator-level API calls
const ADMIN_SECRET = process.env.MESH_ADMIN_SECRET || "";

export function verifyCreator(c: any): boolean {
  const name = c.req.query("name");
  const secret = c.req.header("x-mesh-secret") || c.req.query("secret");
  if (!name || !CREATORS.has(name)) return false;
  if (!ADMIN_SECRET) return false;
  return secret === ADMIN_SECRET;
}

export function registerAdminRoutes(app: Hono) {
  app.post("/api/admin/read-only", async (c) => {
    const room = c.req.query("room");
    const token = c.req.query("token");
    if (!room || !token || !verifyAdmin(room, token))
      return c.json({ error: "unauthorized" }, 401);
    const { read_only } = await c.req.json();
    setRoomReadOnly(room, !!read_only);
    return c.json({ ok: true, read_only: !!read_only });
  });

  app.post("/api/admin/whitelist", async (c) => {
    const room = c.req.query("room");
    const token = c.req.query("token");
    if (!room || !token || !verifyAdmin(room, token))
      return c.json({ error: "unauthorized" }, 401);
    const { add, remove } = await c.req.json();
    if (add) addToWhitelist(room, add);
    if (remove) removeFromWhitelist(room, remove);
    return c.json({ ok: true, whitelist: getWhitelist(room) });
  });

  app.post("/api/admin/kick", async (c) => {
    const room = c.req.query("room");
    const token = c.req.query("token");
    if (!room || !token || !verifyAdmin(room, token))
      return c.json({ error: "unauthorized" }, 401);
    const { name, unban } = await c.req.json();
    if (!name) return c.json({ error: "missing name" }, 400);
    if (unban) unbanAgent(room, name);
    else kickAgent(room, name);
    return c.json({ ok: true, banned: getBanned(room) });
  });

  // Creator-level cleanup — uses MESH_CREATORS env for auth (no admin_token needed)
  app.post("/api/admin/cleanup", async (c) => {
    const room = c.req.query("room");
    if (!room || !verifyCreator(c))
      return c.json({ error: "unauthorized — creators only" }, 401);
    const { remove } = await c.req.json();
    if (!Array.isArray(remove))
      return c.json({ error: 'provide {remove: ["name1", ...]}' }, 400);
    const removed: string[] = [];
    for (const name of remove) {
      kickAgent(room, name);
      removed.push(name);
    }
    return c.json({ ok: true, removed, count: removed.length });
  });

  // Creator-level admin reset — generates a new admin token for a room
  app.post("/api/admin/reset-token", async (c) => {
    const room = c.req.query("room");
    if (!room || !verifyCreator(c))
      return c.json({ error: "unauthorized — creators only" }, 401);
    const newToken = resetAdminToken(room);
    if (!newToken) return c.json({ error: "room not found" }, 404);
    return c.json({
      ok: true,
      room,
      admin_token: newToken,
      message: "New admin token set. Save it securely.",
    });
  });

  app.post("/api/admin/rate-limit-exempt", async (c) => {
    const room = c.req.query("room");
    const token = c.req.query("token") || c.req.header("x-admin-token");
    if (!room || !token || !verifyAdmin(room, token))
      return c.json({ error: "unauthorized" }, 401);
    try {
      const { name, exempt } = await c.req.json();
      if (!name) return c.json({ error: "missing name" }, 400);
      setRateLimitExempt(name, exempt !== false);
      return c.json({ ok: true, name, exempt: exempt !== false });
    } catch (e) {
      return c.json({ error: "invalid json body" }, 400);
    }
  });

  app.get("/api/admin/status", (c) => {
    const room = c.req.query("room");
    const token = c.req.query("token") || c.req.header("x-admin-token");
    if (!room || !token || !verifyAdmin(room, token))
      return c.json({ error: "unauthorized" }, 401);
    return c.json({
      ok: true,
      read_only: isRoomReadOnly(room),
      whitelist: getWhitelist(room),
      banned: getBanned(room),
      rate_limit_exempt: getRateLimitExemptList(),
    });
  });

  // Force-rotate admin token for any room — uses server ADMIN_CLAIM_SECRET
  // Use when original admin lost their token
  app.post("/api/admin/force-rotate", async (c) => {
    const secret = process.env.ADMIN_CLAIM_SECRET;
    if (!secret)
      return c.json({ error: "ADMIN_CLAIM_SECRET not set on server" }, 500);
    const body = (await c.req.json().catch(() => ({}))) as any;
    if (body.claim_secret !== secret)
      return c.json({ error: "invalid secret" }, 401);
    if (!body.room) return c.json({ error: "missing room" }, 400);
    const newToken = rotateAdminToken(body.room);
    if (!newToken) return c.json({ error: "room not found" }, 404);
    return c.json({
      ok: true,
      room: body.room,
      admin_token: newToken,
      message: "Old token is now invalid. Give this to the admin.",
    });
  });

  // One-time claim: set admin token on a legacy room created without one
  // Requires ADMIN_CLAIM_SECRET env var on the server side
  app.post("/api/admin/claim", async (c) => {
    const room = c.req.query("room");
    const secret = process.env.ADMIN_CLAIM_SECRET;
    if (!room) return c.json({ error: "missing room" }, 400);
    if (!secret) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as any;
    if (body.claim_secret !== secret)
      return c.json({ error: "invalid secret" }, 401);
    const result = claimRoomAdmin(room);
    if (!result)
      return c.json(
        { error: "room not found or already has an admin token" },
        400
      );
    return c.json({
      ok: true,
      room,
      admin_token: result,
      message: "Save this token — it won't be shown again",
    });
  });
}
