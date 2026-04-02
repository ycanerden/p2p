
import { Database } from "bun:sqlite";
import { EventEmitter } from "events";
import LZString from "lz-string";
import crypto from "node:crypto";

// Persistent SQLite store using Bun's native driver
// Uses /app/data/ volume on Railway for persistence across deploys
import { existsSync, mkdirSync } from "node:fs";

// ── Helpers ──────────────────────────────────────────────────────────────────
function generateSecureToken(): string {
  return crypto.randomBytes(32).toString('hex');
}
const DB_DIR = process.env.NODE_ENV === "production" ? "/app/data" : ".";
if (DB_DIR !== "." && !existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
export const db = new Database(`${DB_DIR}/mesh.db`, { create: true });

// Event emitter for real-time updates (SSE)
export const messageEvents = new EventEmitter();

// ── Auto-seed default rooms on startup ──────────────────────────────────────
// These rooms persist across deploys even without a volume mount
const DEFAULT_ROOMS = (process.env.DEFAULT_ROOMS || "mesh01").split(",").map(s => s.trim()).filter(Boolean);

function seedDefaultRooms() {
  for (const code of DEFAULT_ROOMS) {
    const exists = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
    if (!exists) {
      const token = generateSecureToken();
      db.prepare("INSERT INTO rooms (code, last_activity, admin_token, is_demo) VALUES (?, ?, ?, ?)").run(code, Date.now(), token, 0);
      console.log(`[seed] Created default room: ${code} admin_token=***REDACTED***`);
    }
  }
}
// Run after tables are created (deferred to end of module init)

// Initialize tables
db.run(`
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    last_activity INTEGER,
    is_demo INTEGER DEFAULT 0
  );
`);

// Migration: admin_token + read_only for room security
try { db.run("ALTER TABLE rooms ADD COLUMN admin_token TEXT DEFAULT NULL;"); } catch (e) {}
try { db.run("ALTER TABLE rooms ADD COLUMN read_only INTEGER DEFAULT 0;"); } catch (e) {}
try { db.run("ALTER TABLE rooms ADD COLUMN is_private INTEGER DEFAULT 0;"); } catch (e) {}
try { db.run("ALTER TABLE rooms ADD COLUMN is_demo INTEGER DEFAULT 0;"); } catch (e) {}
try { db.run("ALTER TABLE rooms ADD COLUMN room_password_hash TEXT DEFAULT NULL;"); } catch (e) {}

// Migration: backfill admin tokens for rooms that were created without one
{
  const rows = db.prepare("SELECT code FROM rooms WHERE admin_token IS NULL OR admin_token = ''").all() as { code: string }[];
  for (const row of rows) {
    const token = generateSecureToken();
    db.prepare("UPDATE rooms SET admin_token = ? WHERE code = ?").run(token, row.code);
    console.log(`[migration] Set admin token for room ${row.code}: ***REDACTED***`);
  }
}

// Admin room password — read from env var, never from code
// Set via: railway variables set ADMIN_ROOM_PASSWORD="xxx" --service p2p
{
  const adminPassword = process.env.ADMIN_ROOM_PASSWORD;
  if (adminPassword) {
    for (const code of DEFAULT_ROOMS) {
      const current = db.prepare("SELECT room_password_hash FROM rooms WHERE code = ?").get(code) as any;
      // Always re-set from env var on startup (in case password was rotated)
      setRoomPassword(code, adminPassword);
      console.log(`[security] Room ${code} password set from ADMIN_ROOM_PASSWORD env var`);
    }
  }
}

// Whitelist: only these agent names can send messages (empty = everyone allowed)
db.run(`CREATE TABLE IF NOT EXISTS room_whitelist (
  room_code TEXT,
  agent_name TEXT,
  PRIMARY KEY(room_code, agent_name)
);`);

// Migration: clear whitelist for default rooms so all agents can join
// TODO: remove once proper invite system is in place
for (const code of DEFAULT_ROOMS) {
  const count = (db.prepare("SELECT COUNT(*) as n FROM room_whitelist WHERE room_code = ?").get(code) as any)?.n;
  if (count > 0) {
    db.prepare("DELETE FROM room_whitelist WHERE room_code = ?").run(code);
    console.log(`[migration] Cleared whitelist for room ${code} (had ${count} entries)`);
  }
}

// Kicked/banned agents
db.run(`CREATE TABLE IF NOT EXISTS room_banned (
  room_code TEXT,
  agent_name TEXT,
  PRIMARY KEY(room_code, agent_name)
);`);

db.run(`CREATE TABLE IF NOT EXISTS rate_limit_exempt (
  agent_name TEXT PRIMARY KEY
);`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_code TEXT,
    sender TEXT,
    recipient TEXT DEFAULT NULL,
    content TEXT,
    timestamp INTEGER,
    msg_type TEXT DEFAULT 'BROADCAST',
    FOREIGN KEY(room_code) REFERENCES rooms(code)
  );
`);

// Migration: Add 'recipient' column if it doesn't exist (for existing databases)
try {
  db.run("ALTER TABLE messages ADD COLUMN recipient TEXT DEFAULT NULL;");
} catch (e) {
  // Column might already exist
}

// Migration: Add 'msg_type' column for structured AI messaging
try {
  db.run("ALTER TABLE messages ADD COLUMN msg_type TEXT DEFAULT 'BROADCAST';");
} catch (e) {
  // Column might already exist
}

// Migration: Add 'reply_to' column for message threading
try {
  db.run("ALTER TABLE messages ADD COLUMN reply_to TEXT DEFAULT NULL;");
} catch (e) {
  // Column might already exist
}

// Add index for fast room_code lookups (rowid is implicit in SQLite)
try {
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_code);");
} catch (e) {
  // Index might already exist
}

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    room_code TEXT,
    name TEXT,
    cursor INTEGER DEFAULT 0,
    last_rowid INTEGER DEFAULT 0,
    last_seen INTEGER,
    PRIMARY KEY(room_code, name),
    FOREIGN KEY(room_code) REFERENCES rooms(code)
  );
`);

// Migration: Add 'last_rowid' column for cursor-free message delivery
try {
  db.run("ALTER TABLE users ADD COLUMN last_rowid INTEGER DEFAULT 0;");
} catch (e) {
  // Column might already exist
}

db.run(`
  CREATE TABLE IF NOT EXISTS agent_cards (
    room_code TEXT,
    name TEXT,
    card_json TEXT,
    updated_at INTEGER,
    PRIMARY KEY(room_code, name),
    FOREIGN KEY(room_code) REFERENCES rooms(code)
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    window_start INTEGER,
    updated_at INTEGER
  );
`);

// ── Presence tracking ─────────────────────────────────────────────────────────
db.run(`
  CREATE TABLE IF NOT EXISTS presence (
    room_code TEXT,
    agent_name TEXT,
    status TEXT DEFAULT 'online',
    last_heartbeat INTEGER,
    is_typing INTEGER DEFAULT 0,
    typing_since INTEGER DEFAULT 0,
    PRIMARY KEY(room_code, agent_name)
  );
`);

// Migration: Add hostname/machine field to presence
try {
  db.run("ALTER TABLE presence ADD COLUMN hostname TEXT DEFAULT '';");
} catch (e) {}

// Migration: Add display_name field to presence
try {
  db.run("ALTER TABLE presence ADD COLUMN display_name TEXT DEFAULT '';");
} catch (e) {}

// Migration: Add role + parent for hierarchy view
try {
  db.run("ALTER TABLE presence ADD COLUMN role TEXT DEFAULT 'worker';");
} catch (e) {}
try {
  db.run("ALTER TABLE presence ADD COLUMN parent_agent TEXT DEFAULT '';");
} catch (e) {}

// ── Webhooks ─────────────────────────────────────────────────────────────────
db.run(`
  CREATE TABLE IF NOT EXISTS webhooks (
    room_code TEXT,
    agent_name TEXT,
    webhook_url TEXT,
    webhook_secret TEXT,
    events TEXT DEFAULT 'message',
    created_at INTEGER,
    PRIMARY KEY(room_code, agent_name)
  );
`);

// Migration: add webhook_secret column if missing (existing DBs created before this column)
try { db.run("ALTER TABLE webhooks ADD COLUMN webhook_secret TEXT DEFAULT NULL;"); } catch {}
// Migration: add events column if missing
try { db.run("ALTER TABLE webhooks ADD COLUMN events TEXT DEFAULT 'message';"); } catch {}

// ── Room context (shared pinned context per room) ────────────────────────────
db.run(`CREATE TABLE IF NOT EXISTS room_context (
  room_code TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(room_code) REFERENCES rooms(code)
);`);

// ── Agent Tokens ─────────────────────────────────────────────────────────────
db.run(`CREATE TABLE IF NOT EXISTS room_agent_tokens (
  room_code TEXT,
  agent_name TEXT,
  token TEXT NOT NULL,
  created_at INTEGER,
  PRIMARY KEY (room_code, agent_name)
);`);

// ── Types ────────────────────────────────────────────────────────────────────

export interface Message {
  id: string;
  from: string;
  to?: string;
  ts: number;
  content: string;
  type?: string;
  reply_to?: string;
}

export interface AgentCard {
  agent?: { name: string; model: string; tool?: string };
  owner?: { name: string; role?: string };
  skills?: string[];
  availability?: string;
  capabilities?: { file_sharing?: boolean; task_assignment?: boolean; [key: string]: any };
  node?: { ip: string; port: number; hostname?: string };
  [key: string]: any;
}

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };

const MAX_MESSAGE_BYTES = 10 * 1024; // 10KB
const ROOM_TTL_MS = 72 * 60 * 60 * 1000; // 72h

// ── Room management ──────────────────────────────────────────────────────────

// Ensure a room with the given code exists — creates it if not
// Used so stale MCP config codes don't error on startup
export function ensureRoom(code: string): void {
  const exists = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!exists) {
    const token = generateSecureToken();
    db.prepare("INSERT OR IGNORE INTO rooms (code, last_activity, admin_token, is_demo) VALUES (?, ?, ?, ?)").run(code, Date.now(), token, 0);
    console.log(`[room] auto-created room ${code} from MCP connection`);
  }
}

export function createRoom(isDemo: boolean = false): { code: string; admin_token: string } {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code: string;
  const checkStmt = db.prepare("SELECT 1 FROM rooms WHERE code = ?");

  do {
    code = Array.from(
      { length: 6 },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (checkStmt.get(code));

  const admin_token = generateSecureToken();
  db.prepare("INSERT INTO rooms (code, last_activity, admin_token, is_demo) VALUES (?, ?, ?, ?)").run(code, Date.now(), admin_token, isDemo ? 1 : 0);
  return { code, admin_token };
}

export function verifyAdmin(roomCode: string, token: string | null | undefined): boolean {
  if (!token) return false;
  const row = db.prepare("SELECT admin_token FROM rooms WHERE code = ?").get(roomCode) as any;
  return row?.admin_token === token;
}

export function setRoomReadOnly(roomCode: string, readOnly: boolean): void {
  db.prepare("UPDATE rooms SET read_only = ? WHERE code = ?").run(readOnly ? 1 : 0, roomCode);
}

export function isRoomReadOnly(roomCode: string): boolean {
  const row = db.prepare("SELECT read_only FROM rooms WHERE code = ?").get(roomCode) as any;
  return row?.read_only === 1;
}

// One-time claim for legacy rooms created without an admin token
export function claimRoomAdmin(roomCode: string): string | null {
  const row = db.prepare("SELECT admin_token FROM rooms WHERE code = ?").get(roomCode) as any;
  if (!row || row.admin_token) return null; // not found or already claimed
  const token = generateSecureToken();
  db.prepare("UPDATE rooms SET admin_token = ? WHERE code = ?").run(token, roomCode);
  return token;
}

export function rotateAdminToken(roomCode: string): string {
  const token = generateSecureToken();
  db.prepare("UPDATE rooms SET admin_token = ? WHERE code = ?").run(token, roomCode);
  return token;
}

// Force-reset admin token (for creators who lost it or need to reclaim)
export function resetAdminToken(roomCode: string): string | null {
  const row = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(roomCode);
  if (!row) return null;
  const token = generateSecureToken();
  db.prepare("UPDATE rooms SET admin_token = ? WHERE code = ?").run(token, roomCode);
  return token;
}

export function addToWhitelist(roomCode: string, agentName: string): void {
  db.prepare("INSERT OR IGNORE INTO room_whitelist (room_code, agent_name) VALUES (?, ?)").run(roomCode, agentName);
}

export function removeFromWhitelist(roomCode: string, agentName: string): void {
  db.prepare("DELETE FROM room_whitelist WHERE room_code = ? AND agent_name = ?").run(roomCode, agentName);
}

export function getWhitelist(roomCode: string): string[] {
  const rows = db.prepare("SELECT agent_name FROM room_whitelist WHERE room_code = ?").all(roomCode) as any[];
  return rows.map(r => r.agent_name);
}

// Returns true if agent is allowed to send (whitelist empty = everyone allowed)
// If an agent token is set in room_agent_tokens, it MUST match.
export function canAgentSend(roomCode: string, agentName: string, providedToken?: string): boolean {
  // 1. Deny if banned.
  const banned = db.prepare("SELECT 1 FROM room_banned WHERE room_code = ? AND agent_name = ?").get(roomCode, agentName);
  if (banned) return false;

  // 2. Check for a registered token for the agent.
  const tokenRow = db.prepare("SELECT token FROM room_agent_tokens WHERE room_code = ? AND agent_name = ?")
    .get(roomCode, agentName) as { token: string } | undefined;

  // If a token is registered for this agent, it is the *only* authentication method.
  // It must be provided and it must be correct.
  if (tokenRow) {
    return providedToken === tokenRow.token;
  }

  // 3. If no token is registered, fall back to whitelist check.
  const whitelistCount = db.prepare("SELECT COUNT(*) as n FROM room_whitelist WHERE room_code = ?").get(roomCode) as any;
  if (whitelistCount.n === 0) {
    return true; // No whitelist means the room is open to agents without tokens.
  }

  // If a whitelist exists, the agent must be on it.
  const allowed = db.prepare("SELECT 1 FROM room_whitelist WHERE room_code = ? AND agent_name = ?").get(roomCode, agentName);
  return !!allowed;
}

export function kickAgent(roomCode: string, agentName: string): void {
  db.prepare("INSERT OR IGNORE INTO room_banned (room_code, agent_name) VALUES (?, ?)").run(roomCode, agentName);
  db.prepare("DELETE FROM presence WHERE room_code = ? AND agent_name = ?").run(roomCode, agentName);
}

export function unbanAgent(roomCode: string, agentName: string): void {
  db.prepare("DELETE FROM room_banned WHERE room_code = ? AND agent_name = ?").run(roomCode, agentName);
}

export function getBanned(roomCode: string): string[] {
  const rows = db.prepare("SELECT agent_name FROM room_banned WHERE room_code = ?").all(roomCode) as any[];
  return rows.map(r => r.agent_name);
}

export function joinRoom(code: string, name: string): { isNew: boolean } | null {
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return null;

  const user = db.prepare("SELECT 1 FROM users WHERE room_code = ? AND name = ?").get(code, name);
  const isNew = !user;
  if (isNew) {
    // Set initial last_rowid to -1 so users see all messages when they first call getMessages()
    // This fixes the bug where new users don't see their own first message
    db.prepare("INSERT INTO users (room_code, name, cursor, last_rowid, last_seen) VALUES (?, ?, ?, ?, ?)")
      .run(code, name, 0, -1, Date.now());
  } else {
    db.prepare("UPDATE users SET last_seen = ? WHERE room_code = ? AND name = ?")
      .run(Date.now(), code, name);
  }

  db.prepare("UPDATE rooms SET last_activity = ? WHERE code = ?").run(Date.now(), code);
  return { isNew };
}

export function roomExists(code: string): boolean {
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  return !!room;
}

export function getRoomCount(): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM rooms").get() as { count: number };
  return row.count;
}

export function getActiveRooms(): { code: string; agent_count: number; message_count: number; last_active: number }[] {
  const rows = db.prepare(`
    SELECT r.code,
      COUNT(DISTINCT CASE WHEN p.agent_name NOT IN ('Viewer','demo-viewer','office-viewer','team-viewer','Atlas','Nova','Echo') THEN p.agent_name END) as agent_count,
      COUNT(DISTINCT CASE WHEN m.sender NOT IN ('Viewer','system','Atlas','Nova','Echo') THEN m.id END) as message_count,
      MAX(COALESCE(p.last_heartbeat, 0)) as last_active
    FROM rooms r
    LEFT JOIN presence p ON p.room_code = r.code
    LEFT JOIN messages m ON m.room_code = r.code
    WHERE r.is_private = 0
    GROUP BY r.code
    HAVING message_count >= 1 OR agent_count >= 1
    ORDER BY last_active DESC
    LIMIT 30
  `).all() as any[];
  return rows;
}

export function setRoomPrivate(roomCode: string, isPrivate: boolean): void {
  db.prepare("UPDATE rooms SET is_private = ? WHERE code = ?").run(isPrivate ? 1 : 0, roomCode);
}

export function isRoomPrivate(roomCode: string): boolean {
  const row = db.prepare("SELECT is_private FROM rooms WHERE code = ?").get(roomCode) as any;
  return row ? row.is_private === 1 : false;
}

// Secure password hashing with salt using Bun's built-in crypto
function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const s = salt || crypto.randomUUID();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(s + ":" + password);
  return { hash: hasher.digest("hex"), salt: s };
}

// Legacy DJB2 hash for backwards compatibility with existing passwords
function legacyHash(s: string): string {
  let h = 5381n;
  for (let i = 0; i < s.length; i++) h = (h * 33n ^ BigInt(s.charCodeAt(i))) & 0xffffffffffffffffn;
  return h.toString(16);
}

export function setRoomPassword(roomCode: string, password: string | null): void {
  if (!password) {
    db.prepare("UPDATE rooms SET room_password_hash = ?, is_private = ? WHERE code = ?").run(null, 0, roomCode);
    return;
  }
  const { hash, salt } = hashPassword(password);
  // Store as "salt:hash" format so we can verify later
  db.prepare("UPDATE rooms SET room_password_hash = ?, is_private = ? WHERE code = ?").run(`${salt}:${hash}`, 1, roomCode);
}

export function verifyRoomPassword(roomCode: string, password: string): boolean {
  const row = db.prepare("SELECT room_password_hash, is_private FROM rooms WHERE code = ?").get(roomCode) as any;
  if (!row) return false;
  if (!row.room_password_hash) return true;
  const stored = row.room_password_hash as string;
  // New format: "salt:hash"
  if (stored.includes(":")) {
    const [salt, expectedHash] = stored.split(":");
    const { hash } = hashPassword(password, salt);
    return hash === expectedHash;
  }
  // Legacy format: plain DJB2 hash — verify and upgrade
  if (legacyHash(password) === stored) {
    // Upgrade to new format on successful verify
    const { hash, salt } = hashPassword(password);
    db.prepare("UPDATE rooms SET room_password_hash = ? WHERE code = ?").run(`${salt}:${hash}`, roomCode);
    return true;
  }
  return false;
}

export function getRoomPasswordHash(roomCode: string): string | null {
  const row = db.prepare("SELECT room_password_hash FROM rooms WHERE code = ?").get(roomCode) as any;
  return row?.room_password_hash || null;
}

// ── Agent Cards ──────────────────────────────────────────────────────────────

export function publishCard(
  code: string,
  name: string,
  card: any
): Ok<{ updated_at: number }> | Err {
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return { ok: false, error: "room_expired_or_not_found" };

  const cardJson = JSON.stringify(card);
  const now = Date.now();

  db.prepare("INSERT OR REPLACE INTO agent_cards (room_code, name, card_json, updated_at) VALUES (?, ?, ?, ?)")
    .run(code, name, cardJson, now);

  // Optional: automatically post a system message when a card is updated
  const agentName = card?.agent?.name || name;
  const agentModel = card?.agent?.model || "unknown";
  appendMessage(code, "system", `${agentName} (${agentModel}) updated their Agent Card.`);

  return { ok: true, updated_at: now };
}

export function getPartnerCards(
  code: string,
  name: string
): Ok<{ cards: Array<{ name: string; card: AgentCard; updated_at: number }> }> | Err {
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return { ok: false, error: "room_expired_or_not_found" };

  // Filter patterns for internal/test agents that shouldn't be visible to real agents
  const HIDDEN_AGENT_PATTERNS = /^(synthetic-\d+|load-tester|test-agent|demo-viewer|live-viewer)/i;

  const rows = db.prepare("SELECT name, card_json, updated_at FROM agent_cards WHERE room_code = ? AND name != ?")
    .all(code, name) as Array<{ name: string; card_json: string; updated_at: number }>;

  const cards = rows
    .filter(row => !HIDDEN_AGENT_PATTERNS.test(row.name))
    .map(row => ({
      name: row.name,
      card: JSON.parse(row.card_json) as AgentCard,
      updated_at: row.updated_at,
    }));

  return { ok: true, cards };
}

// ── Messaging ────────────────────────────────────────────────────────────────

export function appendMessage(
  code: string,
  from: string,
  content: string,
  to?: string,
  msgType: string = "BROADCAST",
  replyTo?: string,
  overrideTs?: number
): Ok<{ id: string }> | Err {
  if (new TextEncoder().encode(content).length > MAX_MESSAGE_BYTES) {
    return { ok: false, error: "message_too_large" };
  }
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return { ok: false, error: "room_expired_or_not_found" };

  const id = crypto.randomUUID();
  const timestamp = overrideTs ?? Date.now();

  // Compress content for storage (transparent to agents). Fall back to raw if compression fails.
  let compressedContent: string;
  try {
    if (content.startsWith("lz:")) {
      compressedContent = content;
    } else {
      const compressed = LZString.compressToEncodedURIComponent(content);
      const verified = LZString.decompressFromEncodedURIComponent(compressed);
      compressedContent = verified === content ? `lz:${compressed}` : content;
    }
  } catch {
    compressedContent = content;
  }

  db.prepare("INSERT INTO messages (id, room_code, sender, recipient, content, timestamp, msg_type, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, code, from, to || null, compressedContent, timestamp, msgType, replyTo || null);

  db.prepare("UPDATE rooms SET last_activity = ? WHERE code = ?").run(Date.now(), code);

  // Extract @mentions from content
  const mentionMatches = content.match(/@([\w\s.-]+?)(?=\s|[^a-zA-Z0-9._\s-]|$)/g);
  const mentions = mentionMatches ? [...new Set(mentionMatches.map(m => m.slice(1).trim()))] : undefined;

  // Emit event for real-time listeners (SSE) with decompressed content (transparent compression)
  const messagePayload = { id, from: from, to: to || undefined, content, ts: timestamp, type: msgType, reply_to: replyTo || undefined, ...(mentions?.length ? { mentions } : {}) };
  messageEvents.emit("message", { room_code: code, message: messagePayload });

  // Fire webhooks (async, non-blocking — never crash the request)
  try {
    fireWebhooks(code, "message", { message: messagePayload });
  } catch (e) {
    console.error(`[webhook] error firing webhooks for ${code}:`, e);
  }

  return { ok: true, id };
}

export function getMessages(
  code: string,
  name: string,
  msgType?: string
): Ok<{ messages: Message[] }> | Err {
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return { ok: false, error: "room_expired_or_not_found" };

  const user = db.prepare("SELECT last_rowid FROM users WHERE room_code = ? AND name = ?").get(code, name) as { last_rowid: number } | undefined;
  if (!user) return { ok: false, error: "not_in_room" };

  // Fetch messages using rowid cursor (avoids skips on mixed broadcast+DM)
  let query = `
    SELECT rowid, id, sender as 'from', recipient as 'to', content, timestamp as ts, msg_type as 'type', reply_to
    FROM messages
    WHERE room_code = ?
    AND rowid > ?
    AND (recipient IS NULL OR recipient = ?)
  `;
  const params: any[] = [code, user.last_rowid, name];

  // Filter by message type if requested
  if (msgType) {
    query += " AND msg_type = ?";
    params.push(msgType);
  }

  query += " ORDER BY rowid ASC";

  const rows = db.prepare(query).all(...params) as any[];

  // Filter out own messages (but always pass through system messages) and decompress content
  const filteredRows = rows.filter(m => m.from === "system" || m.from !== name);
  const filtered = filteredRows
    .map(m => {
      const decompressed = m.content.startsWith("lz:") ? LZString.decompressFromEncodedURIComponent(m.content.slice(3)) || m.content : m.content;
      const mentionMatches = decompressed.match(/@([\w\s.-]+?)(?=\s|[^a-zA-Z0-9._\s-]|$)/g);
      const mentions = mentionMatches ? [...new Set(mentionMatches.map((m: string) => m.slice(1).trim()))] : undefined;
      return {
        id: m.id,
        from: m.from,
        to: m.to,
        ts: m.ts,
        content: decompressed,
        type: m.type,
        reply_to: m.reply_to,
        ...(mentions?.length ? { mentions } : {}),
      };
    });

  // Advance cursor to max rowid seen (eliminates skips)
  const maxRowid = rows.length > 0 ? rows[rows.length - 1].rowid : user.last_rowid;
  db.prepare("UPDATE users SET last_rowid = ?, last_seen = ? WHERE room_code = ? AND name = ?")
    .run(maxRowid, Date.now(), code, name);

  db.prepare("UPDATE rooms SET last_activity = ? WHERE code = ?").run(Date.now(), code);
  return { ok: true, messages: filtered };
}

export function getAllMessages(
  code: string,
  limit: number = 50,
  since?: number,
  viewer?: string
): Ok<{ messages: Message[] }> | Err {
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return { ok: false, error: "room_expired_or_not_found" };

  // Include DMs addressed to viewer; exclude all other DMs
  const dmClause = viewer
    ? "(recipient IS NULL OR recipient = ? OR sender = ?)"
    : "recipient IS NULL";

  let rows: Message[];
  if (viewer) {
    const query = since
      ? db.prepare(`SELECT id, sender as 'from', recipient as 'to', content, timestamp as ts, msg_type as 'type', reply_to FROM messages WHERE room_code = ? AND timestamp > ? AND ${dmClause} ORDER BY timestamp DESC LIMIT ?`)
      : db.prepare(`SELECT id, sender as 'from', recipient as 'to', content, timestamp as ts, msg_type as 'type', reply_to FROM messages WHERE room_code = ? AND ${dmClause} ORDER BY timestamp DESC LIMIT ?`);
    rows = since
      ? query.all(code, since, viewer, viewer, limit) as Message[]
      : query.all(code, viewer, viewer, limit) as Message[];
  } else {
    const query = since
      ? db.prepare(`SELECT id, sender as 'from', recipient as 'to', content, timestamp as ts, msg_type as 'type', reply_to FROM messages WHERE room_code = ? AND timestamp > ? AND ${dmClause} ORDER BY timestamp DESC LIMIT ?`)
      : db.prepare(`SELECT id, sender as 'from', recipient as 'to', content, timestamp as ts, msg_type as 'type', reply_to FROM messages WHERE room_code = ? AND ${dmClause} ORDER BY timestamp DESC LIMIT ?`);
    rows = since
      ? query.all(code, since, limit) as Message[]
      : query.all(code, limit) as Message[];
  }

  const messages = rows
    .map(m => {
      const decompressed = m.content.startsWith("lz:") ? LZString.decompressFromEncodedURIComponent(m.content.slice(3)) || m.content : m.content;
      return {
        ...m,
        content: decompressed,
      };
    })
    .reverse() // chronological order
    .map((m: any) => {
      const mentionMatches = m.content.match(/@([\w\s.-]+?)(?=\s|[^a-zA-Z0-9._\s-]|$)/g);
      const mentions = mentionMatches ? [...new Set(mentionMatches.map((t: string) => t.slice(1).trim()))] : undefined;
      return mentions?.length ? { ...m, mentions } : m;
    });

  return { ok: true, messages };
}

export function searchMessages(roomCode: string, query: string, limit: number = 50): Message[] {
  const lowerQuery = query.toLowerCase();

  // First: try sender match via SQL (no decompression needed)
  const senderMatches = db.prepare(`
    SELECT id, sender as 'from', recipient as 'to', content, timestamp as ts, msg_type as type
    FROM messages WHERE room_code = ? AND LOWER(sender) LIKE ?
    ORDER BY timestamp DESC LIMIT ?
  `).all(roomCode, `%${lowerQuery}%`, limit) as any[];

  const results: Message[] = senderMatches.map(m => ({
    ...m,
    content: m.content.startsWith("lz:") ? LZString.decompressFromEncodedURIComponent(m.content.slice(3)) || m.content : m.content,
  }));

  if (results.length >= limit) return results;

  // Second: scan recent messages for content match (cap at 500 to avoid full table scan)
  const remaining = limit - results.length;
  const seenIds = new Set(results.map(r => r.id));
  const rows = db.prepare(`
    SELECT id, sender as 'from', recipient as 'to', content, timestamp as ts, msg_type as type
    FROM messages WHERE room_code = ?
    ORDER BY timestamp DESC LIMIT 500
  `).all(roomCode) as any[];

  for (const m of rows) {
    if (seenIds.has(m.id)) continue;
    const plainContent = m.content.startsWith("lz:")
      ? LZString.decompressFromEncodedURIComponent(m.content.slice(3)) || m.content
      : m.content;
    if (plainContent.toLowerCase().includes(lowerQuery)) {
      results.push({ ...m, content: plainContent });
      if (results.length >= limit) break;
    }
  }

  return results;
}

export function deleteMessage(messageId: string, roomCode: string): boolean {
  const result = db.prepare("DELETE FROM messages WHERE id = ? AND room_code = ?").run(messageId, roomCode);
  return result.changes > 0;
}

export function redactMessage(messageId: string, roomCode: string): boolean {
  const compressed = LZString.compressToEncodedURIComponent("[redacted by admin]");
  const result = db.prepare("UPDATE messages SET content = ? WHERE id = ? AND room_code = ?")
    .run(`lz:${compressed}`, messageId, roomCode);
  return result.changes > 0;
}

// ── Room Status ──────────────────────────────────────────────────────────────

export function getRoomStatus(
  code: string,
  name: string
): Ok<{ connected: boolean; partners: any[]; message_count: number; context: any }> | Err {
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return { ok: false, error: "room_expired_or_not_found" };

  const fiveMinsAgo = Date.now() - 5 * 60 * 1000;

  const partners = db.prepare(`
    SELECT u.name, c.card_json
    FROM users u
    LEFT JOIN agent_cards c ON u.room_code = c.room_code AND u.name = c.name
    WHERE u.room_code = ?
      AND u.name != ?
      AND u.last_seen > ?
      AND u.name NOT LIKE '%viewer%'
      AND u.name NOT LIKE 'Viewer%'
      AND u.name NOT LIKE 'synthetic-%'
  `).all(code, name, fiveMinsAgo) as any[];

  const partnersWithCards = partners.map(p => ({
    name: p.name,
    card: p.card_json ? JSON.parse(p.card_json) : null
  }));

  const countRow = db.prepare("SELECT COUNT(*) as count FROM messages WHERE room_code = ?").get(code) as { count: number };

  return {
    ok: true,
    connected: partnersWithCards.length > 0,
    partners: partnersWithCards,
    message_count: countRow.count,
    context: getRoomContext(code), // Shared room-level context
  };
}

export function getRoomContext(room: string): { content: string; updated_by: string; updated_at: number } | null {
  const row = db.prepare("SELECT content, updated_by, updated_at FROM room_context WHERE room_code = ?").get(room) as any;
  return row ? { content: row.content, updated_by: row.updated_by, updated_at: row.updated_at } : null;
}

export function setRoomContext(room: string, content: string, updatedBy: string) {
  db.prepare(`
    INSERT INTO room_context (room_code, content, updated_by, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(room_code) DO UPDATE SET
      content=excluded.content,
      updated_by=excluded.updated_by,
      updated_at=excluded.updated_at
  `).run(room, content, updatedBy, Date.now());
}

// ── GC ────────────────────────────────────────────────────────────────────────

export function sweepExpiredRooms(): number {
  const now = Date.now();
  // Standard TTL: 72h
  const standardThreshold = now - ROOM_TTL_MS;
  // Demo TTL: 1h
  const demoThreshold = now - (60 * 60 * 1000);

  const expired = db.prepare(`
    SELECT code FROM rooms
    WHERE (is_demo = 0 AND last_activity < ?)
       OR (is_demo = 1 AND last_activity < ?)
  `).all(standardThreshold, demoThreshold) as { code: string }[];

  for (const row of expired) {
    db.prepare("DELETE FROM messages WHERE room_code = ?").run(row.code);
    db.prepare("DELETE FROM users WHERE room_code = ?").run(row.code);
    db.prepare("DELETE FROM rooms WHERE code = ?").run(row.code);
  }

  // Also clean up stale rate limit entries (older than 1 hour)
  const rateLimitThreshold = now - (60 * 60 * 1000);
  db.prepare("DELETE FROM rate_limits WHERE window_start < ?").run(rateLimitThreshold);

  return expired.length;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export function generateAgentToken(roomCode: string, agentName: string): string {
  const token = generateSecureToken();
  db.prepare(`
    INSERT INTO room_agent_tokens (room_code, agent_name, token, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(room_code, agent_name) DO UPDATE SET
      token=excluded.token, created_at=excluded.created_at
  `).run(roomCode, agentName, token, Date.now());
  return token;
}

// ── Rate Limiting ────────────────────────────────────────────────────────────

export function checkRateLimitPersistent(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const state = db.prepare("SELECT count, window_start FROM rate_limits WHERE key = ?").get(key) as { count: number; window_start: number } | undefined;

  // If no entry or window expired, reset
  if (!state || now - state.window_start > windowMs) {
    db.prepare("INSERT OR REPLACE INTO rate_limits (key, count, window_start, updated_at) VALUES (?, 1, ?, ?)")
      .run(key, now, now);
    return true;
  }

  // Check if limit exceeded
  if (state.count >= max) {
    return false;
  }

  // Increment count
  db.prepare("UPDATE rate_limits SET count = count + 1, updated_at = ? WHERE key = ?")
    .run(now, key);
  return true;
}

export function isExemptFromRateLimit(agentName: string): boolean {
  const row = db.prepare("SELECT 1 FROM rate_limit_exempt WHERE agent_name = ?").get(agentName);
  return !!row;
}

export function setRateLimitExempt(agentName: string, exempt: boolean): void {
  if (exempt) {
    db.prepare("INSERT OR IGNORE INTO rate_limit_exempt (agent_name) VALUES (?)").run(agentName);
  } else {
    db.prepare("DELETE FROM rate_limit_exempt WHERE agent_name = ?").run(agentName);
  }
}

export function getRateLimitExemptList(): string[] {
  const rows = db.prepare("SELECT agent_name FROM rate_limit_exempt").all() as any[];
  return rows.map(r => r.agent_name);
}

// ── Presence & Typing ────────────────────────────────────────────────────────

export function updatePresence(roomCode: string, agentName: string, status: string = "online", hostname?: string, role?: string, parentAgent?: string) {
  const now = Date.now();
  db.prepare(`INSERT OR REPLACE INTO presence (room_code, agent_name, status, last_heartbeat, is_typing, typing_since, hostname, display_name, role, parent_agent)
    VALUES (?, ?, ?, ?,
      COALESCE((SELECT is_typing FROM presence WHERE room_code = ? AND agent_name = ?), 0),
      COALESCE((SELECT typing_since FROM presence WHERE room_code = ? AND agent_name = ?), 0),
      COALESCE(?, (SELECT hostname FROM presence WHERE room_code = ? AND agent_name = ?), ''),
      COALESCE((SELECT display_name FROM presence WHERE room_code = ? AND agent_name = ?), ''),
      COALESCE(?, (SELECT role FROM presence WHERE room_code = ? AND agent_name = ?), 'worker'),
      COALESCE(?, (SELECT parent_agent FROM presence WHERE room_code = ? AND agent_name = ?), ''))`)
    .run(roomCode, agentName, status, now,
      roomCode, agentName, roomCode, agentName,
      hostname || null, roomCode, agentName,
      roomCode, agentName,
      role || null, roomCode, agentName,
      parentAgent || null, roomCode, agentName);
}

export function setTyping(roomCode: string, agentName: string, isTyping: boolean) {
  const now = Date.now();
  db.prepare(`INSERT OR REPLACE INTO presence (room_code, agent_name, status, last_heartbeat, is_typing, typing_since)
    VALUES (?, ?, 'online', ?, ?, ?)`)
    .run(roomCode, agentName, now, isTyping ? 1 : 0, isTyping ? now : 0);
}

export function getRoomPresence(roomCode: string): Array<{ agent_name: string; display_name: string; status: string; is_typing: boolean; last_heartbeat: number; hostname: string; role: string; parent_agent: string }> {
  // Show all agents seen in the last 24 hours (not just 5 minutes)
  const twentyFourHoursAgo = Date.now() - 86_400_000;
  const rows = db.prepare(`SELECT agent_name, status, is_typing, last_heartbeat, hostname, display_name, role, parent_agent FROM presence
    WHERE room_code = ? AND last_heartbeat > ?`).all(roomCode, twentyFourHoursAgo) as any[];

  const now = Date.now();
  return rows.map(r => ({
    agent_name: r.agent_name,
    display_name: r.display_name || r.agent_name,
    // Online if heartbeat within last 5 minutes (was 60s — too aggressive)
    status: r.last_heartbeat > now - 300_000 ? r.status : "offline",
    is_typing: r.is_typing === 1 && r.last_heartbeat > now - 30_000,
    last_heartbeat: r.last_heartbeat,
    hostname: r.hostname || "",
    role: r.role || "worker",
    parent_agent: r.parent_agent || "",
  }));
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

export function registerWebhook(roomCode: string, agentName: string, webhookUrl: string, events: string = "message", secret?: string) {
  db.prepare("INSERT OR REPLACE INTO webhooks (room_code, agent_name, webhook_url, webhook_secret, events, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(roomCode, agentName, webhookUrl, secret || null, events, Date.now());
}

export function removeWebhook(roomCode: string, agentName: string) {
  db.prepare("DELETE FROM webhooks WHERE room_code = ? AND agent_name = ?")
    .run(roomCode, agentName);
}

export function getRoomWebhooks(roomCode: string): Array<{ agent_name: string; webhook_url: string; webhook_secret: string | null; events: string }> {
  return db.prepare("SELECT agent_name, webhook_url, webhook_secret, events FROM webhooks WHERE room_code = ?")
    .all(roomCode) as any[];
}

export async function fireWebhooks(roomCode: string, event: string, payload: any) {
  let hooks: Array<{ agent_name: string; webhook_url: string; webhook_secret: string | null; events: string }>;
  try { hooks = getRoomWebhooks(roomCode); } catch (e) { console.error("[webhooks] failed to get hooks:", e); return; }
  for (const hook of hooks) {
    let shouldFire = hook.events.includes(event) || hook.events === "*";

    // For 'message' events, refine delivery logic
    if (shouldFire && event === "message" && payload.message) {
      const msg = payload.message;
      const isMentioned = msg.mentions?.includes(hook.agent_name);
      const isTargeted = msg.to === hook.agent_name;
      const isBroadcast = !msg.to;

      // Only fire if: it's a broadcast, OR agent is mentioned, OR it's a DM to this agent
      if (!isBroadcast && !isMentioned && !isTargeted) {
        shouldFire = false;
      }
    }

    if (shouldFire) {
      const body = JSON.stringify({
        event,
        room: roomCode,
        ...payload,
        ts: Date.now(),
      });

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (hook.webhook_secret) {
        const hmac = crypto.createHmac("sha256", hook.webhook_secret).update(body).digest("hex");
        headers["x-mesh-signature"] = hmac;
      }

      // Add idempotency key
      const idempotencyKey = `hook:${roomCode}:${payload.message?.id || "no-id"}:${hook.agent_name}`;
      headers["x-idempotency-key"] = idempotencyKey;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

        fetch(hook.webhook_url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        }).then(() => clearTimeout(timeout))
          .catch(() => clearTimeout(timeout));
      } catch (e) {
        // fail soft
      }
    }
  }
}

// ── Task Assignments ─────────────────────────────────────────────────────────
db.run(`CREATE TABLE IF NOT EXISTS room_assignments (
  room_code TEXT,
  agent_name TEXT,
  task_id TEXT,
  task_title TEXT,
  status TEXT,
  assigned_at INTEGER,
  due_date INTEGER,
  PRIMARY KEY(room_code, agent_name, task_id)
);`);

// ── Task Queue (claimable tasks for Conductor integration) ──────────────────
db.run(`CREATE TABLE IF NOT EXISTS task_queue (
  room_code TEXT NOT NULL,
  task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  priority INTEGER DEFAULT 0,
  claimed_by TEXT DEFAULT NULL,
  claimed_at INTEGER DEFAULT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  branch_name TEXT DEFAULT NULL,
  pr_url TEXT DEFAULT NULL,
  metadata TEXT DEFAULT '{}',
  PRIMARY KEY (room_code, task_id)
);`);

// Event emitter for task queue changes (SSE)
export const taskEvents = new EventEmitter();

export function assignTask(
  roomCode: string,
  agentName: string,
  taskId: string,
  taskTitle: string,
  dueDate: number
) {
  const assignment = {
    room_code: roomCode,
    agent_name: agentName,
    task_id: taskId,
    task_title: taskTitle,
    status: "pending" as const,
    assigned_at: Date.now(),
    due_date: dueDate,
  };
  db.prepare(
    `INSERT OR REPLACE INTO room_assignments (room_code, agent_name, task_id, task_title, status, assigned_at, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(roomCode, agentName, taskId, taskTitle, "pending", assignment.assigned_at, dueDate);
  return assignment;
}

export function updateTaskStatus(
  roomCode: string,
  agentName: string,
  taskId: string,
  status: "pending" | "in_progress" | "blocked" | "done"
): void {
  db.prepare(
    `UPDATE room_assignments SET status = ? WHERE room_code = ? AND agent_name = ? AND task_id = ?`
  ).run(status, roomCode, agentName, taskId);
}

export function getRoomTasks(roomCode: string) {
  return db.prepare(`SELECT * FROM room_assignments WHERE room_code = ? ORDER BY assigned_at`).all(roomCode);
}

export function getAllAgentTasks(agentName: string) {
  return db.prepare(`SELECT * FROM room_assignments WHERE agent_name = ? ORDER BY assigned_at`).all(agentName);
}

// ── Task Queue Functions ─────────────────────────────────────────────────────

export function createQueueTask(
  roomCode: string,
  taskId: string,
  title: string,
  description: string,
  createdBy: string,
  priority: number = 0
) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO task_queue (room_code, task_id, title, description, status, priority, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`
  ).run(roomCode, taskId, title, description, priority, createdBy, now, now);
  const task = { room_code: roomCode, task_id: taskId, title, description, status: "open", priority, created_by: createdBy, created_at: now, updated_at: now };
  taskEvents.emit("task", { type: "created", room_code: roomCode, task });
  return task;
}

export function claimQueueTask(
  roomCode: string,
  taskId: string,
  agentName: string
): { ok: true } | { ok: false; error: string } {
  const now = Date.now();
  const result = db.prepare(
    `UPDATE task_queue SET claimed_by = ?, claimed_at = ?, status = 'claimed', updated_at = ?
     WHERE room_code = ? AND task_id = ? AND status = 'open'`
  ).run(agentName, now, now, roomCode, taskId);
  if (result.changes === 0) {
    return { ok: false, error: "task_not_available" };
  }
  taskEvents.emit("task", { type: "claimed", room_code: roomCode, task_id: taskId, claimed_by: agentName });
  return { ok: true };
}

export function releaseQueueTask(
  roomCode: string,
  taskId: string,
  agentName: string
): { ok: true } | { ok: false; error: string } {
  const now = Date.now();
  const result = db.prepare(
    `UPDATE task_queue SET claimed_by = NULL, claimed_at = NULL, status = 'open', updated_at = ?
     WHERE room_code = ? AND task_id = ? AND claimed_by = ?`
  ).run(now, roomCode, taskId, agentName);
  if (result.changes === 0) {
    return { ok: false, error: "not_your_task" };
  }
  taskEvents.emit("task", { type: "released", room_code: roomCode, task_id: taskId, released_by: agentName });
  return { ok: true };
}

export function updateQueueTask(
  roomCode: string,
  taskId: string,
  agentName: string,
  updates: { status?: string; branch_name?: string; pr_url?: string; metadata?: string }
): { ok: true } | { ok: false; error: string } {
  // Only the claiming agent can update
  const task = db.prepare(
    `SELECT claimed_by FROM task_queue WHERE room_code = ? AND task_id = ?`
  ).get(roomCode, taskId) as any;
  if (!task) return { ok: false, error: "task_not_found" };
  if (task.claimed_by !== agentName) return { ok: false, error: "not_your_task" };

  const now = Date.now();
  const sets: string[] = ["updated_at = ?"];
  const vals: any[] = [now];
  if (updates.status) { sets.push("status = ?"); vals.push(updates.status); }
  if (updates.branch_name) { sets.push("branch_name = ?"); vals.push(updates.branch_name); }
  if (updates.pr_url) { sets.push("pr_url = ?"); vals.push(updates.pr_url); }
  if (updates.metadata) { sets.push("metadata = ?"); vals.push(updates.metadata); }

  vals.push(roomCode, taskId);
  db.prepare(`UPDATE task_queue SET ${sets.join(", ")} WHERE room_code = ? AND task_id = ?`).run(...vals);
  taskEvents.emit("task", { type: "updated", room_code: roomCode, task_id: taskId, updates });
  return { ok: true };
}

export function getOpenQueueTasks(roomCode: string) {
  return db.prepare(
    `SELECT * FROM task_queue WHERE room_code = ? AND status = 'open' ORDER BY priority DESC, created_at ASC`
  ).all(roomCode);
}

export function getQueueTasks(roomCode: string, status?: string) {
  if (status) {
    return db.prepare(`SELECT * FROM task_queue WHERE room_code = ? AND status = ? ORDER BY created_at DESC`).all(roomCode, status);
  }
  return db.prepare(`SELECT * FROM task_queue WHERE room_code = ? ORDER BY created_at DESC`).all(roomCode);
}

export function expireStaleQueueClaims(maxAgeMs: number = 10 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  const result = db.prepare(
    `UPDATE task_queue SET claimed_by = NULL, claimed_at = NULL, status = 'open', updated_at = ?
     WHERE status IN ('claimed', 'in_progress') AND claimed_at < ?`
  ).run(Date.now(), cutoff);
  return result.changes;
}

// ── Run seeds after all tables are created ───────────────────────────────────
seedDefaultRooms();

export { generateSecureToken };
