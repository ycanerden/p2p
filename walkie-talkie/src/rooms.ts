import { Database } from "bun:sqlite";
import { EventEmitter } from "events";
import LZString from "lz-string";

// Persistent SQLite store using Bun's native driver
// Uses /app/data/ volume on Railway for persistence across deploys
import { existsSync, mkdirSync } from "node:fs";
const DB_DIR = process.env.NODE_ENV === "production" ? "/app/data" : ".";
if (DB_DIR !== "." && !existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
const db = new Database(`${DB_DIR}/mesh.db`, { create: true });

// Event emitter for real-time updates (SSE)
export const messageEvents = new EventEmitter();

// ── Auto-seed default rooms on startup ──────────────────────────────────────
// These rooms persist across deploys even without a volume mount
const DEFAULT_ROOMS = (process.env.DEFAULT_ROOMS || "mesh01").split(",").map(s => s.trim()).filter(Boolean);

function seedDefaultRooms() {
  for (const code of DEFAULT_ROOMS) {
    const exists = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
    if (!exists) {
      db.prepare("INSERT INTO rooms (code, last_activity) VALUES (?, ?)").run(code, Date.now());
      console.log(`[seed] Created default room: ${code}`);
    }
  }
}
// Run after tables are created (deferred to end of module init)

// Initialize tables
db.run(`
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    last_activity INTEGER
  );
`);

// Migration: admin_token + read_only for room security
try { db.run("ALTER TABLE rooms ADD COLUMN admin_token TEXT DEFAULT NULL;"); } catch (e) {}
try { db.run("ALTER TABLE rooms ADD COLUMN read_only INTEGER DEFAULT 0;"); } catch (e) {}

// Whitelist: only these agent names can send messages (empty = everyone allowed)
db.run(`CREATE TABLE IF NOT EXISTS room_whitelist (
  room_code TEXT,
  agent_name TEXT,
  PRIMARY KEY(room_code, agent_name)
);`);

// Kicked/banned agents
db.run(`CREATE TABLE IF NOT EXISTS room_banned (
  room_code TEXT,
  agent_name TEXT,
  PRIMARY KEY(room_code, agent_name)
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

// ── Metrics tracking ──────────────────────────────────────────────────────────
db.run(`
  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT,
    room_code TEXT,
    agent_name TEXT,
    latency_ms REAL DEFAULT 0,
    timestamp INTEGER
  );
`);

try {
  db.run("CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(timestamp);");
  db.run("CREATE INDEX IF NOT EXISTS idx_metrics_type ON metrics(event_type);");
} catch (e) {}

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

// Agent personality persistence — survives session restarts
db.run(`CREATE TABLE IF NOT EXISTS agent_personalities (
  name TEXT PRIMARY KEY,
  personality TEXT DEFAULT '',
  system_prompt TEXT DEFAULT '',
  skills TEXT DEFAULT '',
  model TEXT DEFAULT '',
  tool TEXT DEFAULT '',
  created_at INTEGER,
  updated_at INTEGER
);`);
try { db.run("ALTER TABLE agent_personalities ADD COLUMN model TEXT DEFAULT '';"); } catch(e) {}
try { db.run("ALTER TABLE agent_personalities ADD COLUMN tool TEXT DEFAULT '';"); } catch(e) {}

// ── Message reactions ─────────────────────────────────────────────────────────
db.run(`
  CREATE TABLE IF NOT EXISTS reactions (
    message_id TEXT,
    agent_name TEXT,
    emoji TEXT,
    created_at INTEGER,
    PRIMARY KEY(message_id, agent_name)
  );
`);

export interface Message {
  id: string;
  from: string;
  to?: string;
  ts: number;
  content: string;
  type?: string;
}

const MAX_MESSAGE_BYTES = 10 * 1024; // 10KB
const ROOM_TTL_MS = 72 * 60 * 60 * 1000; // 72h

// ── Room management ──────────────────────────────────────────────────────────

// Ensure a room with the given code exists — creates it if not
// Used so stale MCP config codes don't error on startup
export function ensureRoom(code: string): void {
  const exists = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!exists) {
    const token = crypto.randomUUID();
    db.prepare("INSERT OR IGNORE INTO rooms (code, last_activity, admin_token) VALUES (?, ?, ?)").run(code, Date.now(), token);
    console.log(`[room] auto-created room ${code} from MCP connection`);
  }
}

export function createRoom(): { code: string; admin_token: string } {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code: string;
  const checkStmt = db.prepare("SELECT 1 FROM rooms WHERE code = ?");

  do {
    code = Array.from(
      { length: 6 },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (checkStmt.get(code));

  const admin_token = crypto.randomUUID();
  db.prepare("INSERT INTO rooms (code, last_activity, admin_token) VALUES (?, ?, ?)").run(code, Date.now(), admin_token);
  return { code, admin_token };
}

export function verifyAdmin(roomCode: string, token: string): boolean {
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
  const token = crypto.randomUUID();
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
export function canAgentSend(roomCode: string, agentName: string): boolean {
  const banned = db.prepare("SELECT 1 FROM room_banned WHERE room_code = ? AND agent_name = ?").get(roomCode, agentName);
  if (banned) return false;
  const whitelistCount = db.prepare("SELECT COUNT(*) as n FROM room_whitelist WHERE room_code = ?").get(roomCode) as any;
  if (whitelistCount.n === 0) return true; // no whitelist = open room
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

export function joinRoom(code: string, name: string): boolean | null {
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return null;

  const user = db.prepare("SELECT 1 FROM users WHERE room_code = ? AND name = ?").get(code, name);
  if (!user) {
    db.prepare("INSERT INTO users (room_code, name, cursor, last_seen) VALUES (?, ?, 0, ?)")
      .run(code, name, Date.now());
  } else {
    db.prepare("UPDATE users SET last_seen = ? WHERE room_code = ? AND name = ?")
      .run(Date.now(), code, name);
  }
  
  db.prepare("UPDATE rooms SET last_activity = ? WHERE code = ?").run(Date.now(), code);
  return true as const;
}

export function getRoomCount(): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM rooms").get() as { count: number };
  return row.count;
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

export interface AgentCard {
  agent?: { name: string; model: string; tool?: string };
  owner?: { name: string; role?: string };
  skills?: string[];
  availability?: string;
  capabilities?: { file_sharing?: boolean; task_assignment?: boolean; [key: string]: any };
  node?: { ip: string; port: number; hostname?: string };
  [key: string]: any;
}

export function getPartnerCards(
  code: string,
  name: string
): Ok<{ cards: Array<{ name: string; card: AgentCard; updated_at: number }> }> | Err {
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return { ok: false, error: "room_expired_or_not_found" };

  const rows = db.prepare("SELECT name, card_json, updated_at FROM agent_cards WHERE room_code = ? AND name != ?")
    .all(code, name) as Array<{ name: string; card_json: string; updated_at: number }>;

  const cards = rows.map(row => ({
    name: row.name,
    card: JSON.parse(row.card_json) as AgentCard,
    updated_at: row.updated_at,
  }));

  return { ok: true, cards };
}

export function getNodes(code: string): Ok<{ nodes: Array<{ name: string; node: any; updated_at: number }> }> | Err {
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return { ok: false, error: "room_expired_or_not_found" };

  const rows = db.prepare("SELECT name, card_json, updated_at FROM agent_cards WHERE room_code = ?")
    .all(code) as Array<{ name: string; card_json: string; updated_at: number }>;

  const nodes = rows
    .map(row => ({
      name: row.name,
      card: JSON.parse(row.card_json) as AgentCard,
      updated_at: row.updated_at,
    }))
    .filter(c => c.card.node)
    .map(c => ({
      name: c.name,
      node: c.card.node,
      updated_at: c.updated_at,
    }));

  return { ok: true, nodes };
}

// ── MCP tool operations ───────────────────────────────────────────────────────

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };

export function appendMessage(
  code: string,
  from: string,
  content: string,
  to?: string,
  msgType: string = "BROADCAST",
  replyTo?: string
): Ok<{ id: string }> | Err {
  if (new TextEncoder().encode(content).length > MAX_MESSAGE_BYTES) {
    return { ok: false, error: "message_too_large" };
  }
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return { ok: false, error: "room_expired_or_not_found" };

  const id = crypto.randomUUID();
  const timestamp = Date.now();

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

  // Track metric
  trackMetric("message_sent", code, from);

  // Emit event for real-time listeners (SSE) with decompressed content (transparent compression)
  const messagePayload = { id, from: from, to: to || undefined, content, ts: timestamp, type: msgType, reply_to: replyTo || undefined };
  messageEvents.emit("message", { room_code: code, message: messagePayload });

  // Fire webhooks (async, non-blocking)
  fireWebhooks(code, "message", { message: messagePayload });

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
    SELECT rowid, id, sender as 'from', recipient as 'to', content, timestamp as ts, msg_type as 'type'
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

  // Filter out own messages and decompress content
  const filtered = rows
    .filter(m => m.from !== name)
    .map(m => ({
      id: m.id,
      from: m.from,
      to: m.to,
      ts: m.ts,
      content: m.content.startsWith("lz:") ? LZString.decompressFromEncodedURIComponent(m.content.slice(3)) || m.content : m.content,
      type: m.type
    }));

  // Advance cursor to max rowid seen (eliminates skips)
  const maxRowid = rows.length > 0 ? rows[rows.length - 1].rowid : user.last_rowid;
  db.prepare("UPDATE users SET last_rowid = ?, last_seen = ? WHERE room_code = ? AND name = ?")
    .run(maxRowid, Date.now(), code, name);

  db.prepare("UPDATE rooms SET last_activity = ? WHERE code = ?").run(Date.now(), code);
  return { ok: true, messages: filtered };
}

export function getAllMessages(
  code: string
): Ok<{ messages: Message[] }> | Err {
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return { ok: false, error: "room_expired_or_not_found" };

  const messages = (db.prepare("SELECT id, sender as 'from', recipient as 'to', content, timestamp as ts, msg_type as 'type' FROM messages WHERE room_code = ?")
    .all(code) as Message[])
    .map(m => ({
      ...m,
      content: m.content.startsWith("lz:") ? LZString.decompressFromEncodedURIComponent(m.content.slice(3)) || m.content : m.content
    }));

  return { ok: true, messages };
}

export function getRoomStatus(
  code: string,
  name: string
): Ok<{ connected: boolean; partners: any[]; message_count: number }> | Err {
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return { ok: false, error: "room_expired_or_not_found" };

  const partners = db.prepare(`
    SELECT u.name, c.card_json 
    FROM users u
    LEFT JOIN agent_cards c ON u.room_code = c.room_code AND u.name = c.name
    WHERE u.room_code = ? AND u.name != ?
  `).all(code, name) as any[];

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
  };
}

// ── GC ────────────────────────────────────────────────────────────────────────

export function sweepExpiredRooms(): number {
  const now = Date.now();
  const threshold = now - ROOM_TTL_MS;

  const expired = db.prepare("SELECT code FROM rooms WHERE last_activity < ?").all(threshold) as { code: string }[];

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

// ── Metrics ──────────────────────────────────────────────────────────────────

export function trackMetric(eventType: string, roomCode: string, agentName: string, latencyMs: number = 0) {
  db.prepare("INSERT INTO metrics (event_type, room_code, agent_name, latency_ms, timestamp) VALUES (?, ?, ?, ?, ?)")
    .run(eventType, roomCode, agentName, latencyMs, Date.now());
}

export function getMessagesPerMinute(): number {
  const oneMinuteAgo = Date.now() - 60_000;
  const row = db.prepare("SELECT COUNT(*) as count FROM metrics WHERE event_type = 'message_sent' AND timestamp > ?")
    .get(oneMinuteAgo) as { count: number };
  return row.count;
}

export function getAvgLatencyMs(): number {
  const fiveMinutesAgo = Date.now() - 300_000;
  const row = db.prepare("SELECT AVG(latency_ms) as avg FROM metrics WHERE event_type = 'api_request' AND timestamp > ? AND latency_ms > 0")
    .get(fiveMinutesAgo) as { avg: number | null };
  return Math.round((row.avg || 0) * 100) / 100;
}

export function getTotalMessagesSent(): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM metrics WHERE event_type = 'message_sent'")
    .get() as { count: number };
  return row.count;
}

export function getActiveAgentsCount(): number {
  const fiveMinutesAgo = Date.now() - 300_000;
  const row = db.prepare("SELECT COUNT(DISTINCT agent_name) as count FROM presence WHERE last_heartbeat > ?")
    .get(fiveMinutesAgo) as { count: number };
  return row.count;
}

export function cleanOldMetrics() {
  const oneDayAgo = Date.now() - 86_400_000;
  db.prepare("DELETE FROM metrics WHERE timestamp < ?").run(oneDayAgo);
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
  const fiveMinutesAgo = Date.now() - 300_000;
  const rows = db.prepare(`SELECT agent_name, status, is_typing, last_heartbeat, hostname, display_name, role, parent_agent FROM presence
    WHERE room_code = ? AND last_heartbeat > ?`).all(roomCode, fiveMinutesAgo) as any[];

  const now = Date.now();
  return rows.map(r => ({
    agent_name: r.agent_name,
    display_name: r.display_name || r.agent_name,
    status: r.last_heartbeat > now - 60_000 ? r.status : "offline",
    is_typing: r.is_typing === 1 && r.last_heartbeat > now - 10_000,
    last_heartbeat: r.last_heartbeat,
    hostname: r.hostname || "",
    role: r.role || "worker",
    parent_agent: r.parent_agent || "",
  }));
}

export function setDisplayName(roomCode: string, agentName: string, displayName: string): boolean {
  const result = db.prepare(
    `UPDATE presence SET display_name = ? WHERE room_code = ? AND agent_name = ?`
  ).run(displayName, roomCode, agentName);
  return result.changes > 0;
}

export function getDisplayName(roomCode: string, agentName: string): string {
  const row = db.prepare(
    `SELECT display_name FROM presence WHERE room_code = ? AND agent_name = ?`
  ).get(roomCode, agentName) as any;
  return row?.display_name || agentName;
}

// ── Reactions ────────────────────────────────────────────────────────────────

export function addReaction(messageId: string, agentName: string, emoji: string): { ok: boolean } {
  db.prepare("INSERT OR REPLACE INTO reactions (message_id, agent_name, emoji, created_at) VALUES (?, ?, ?, ?)")
    .run(messageId, agentName, emoji, Date.now());
  return { ok: true };
}

export function removeReaction(messageId: string, agentName: string): { ok: boolean } {
  db.prepare("DELETE FROM reactions WHERE message_id = ? AND agent_name = ?")
    .run(messageId, agentName);
  return { ok: true };
}

export function getMessageReactions(messageId: string): Array<{ agent_name: string; emoji: string; created_at: number }> {
  return db.prepare("SELECT agent_name, emoji, created_at FROM reactions WHERE message_id = ?")
    .all(messageId) as any[];
}

// ── Webhooks ─────────────────────────────────────────────────────────────────
db.run(`
  CREATE TABLE IF NOT EXISTS webhooks (
    room_code TEXT,
    agent_name TEXT,
    webhook_url TEXT,
    events TEXT DEFAULT 'message',
    created_at INTEGER,
    PRIMARY KEY(room_code, agent_name)
  );
`);

export function registerWebhook(roomCode: string, agentName: string, webhookUrl: string, events: string = "message") {
  db.prepare("INSERT OR REPLACE INTO webhooks (room_code, agent_name, webhook_url, events, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(roomCode, agentName, webhookUrl, events, Date.now());
}

export function removeWebhook(roomCode: string, agentName: string) {
  db.prepare("DELETE FROM webhooks WHERE room_code = ? AND agent_name = ?")
    .run(roomCode, agentName);
}

export function getRoomWebhooks(roomCode: string): Array<{ agent_name: string; webhook_url: string; events: string }> {
  return db.prepare("SELECT agent_name, webhook_url, events FROM webhooks WHERE room_code = ?")
    .all(roomCode) as any[];
}

export async function fireWebhooks(roomCode: string, event: string, payload: any) {
  const hooks = getRoomWebhooks(roomCode);
  for (const hook of hooks) {
    if (hook.events.includes(event) || hook.events === "*") {
      try {
        fetch(hook.webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event, room: roomCode, ...payload, ts: Date.now() }),
        }).catch(() => {}); // fire and forget
      } catch (e) {}
    }
  }
}

// ── Global Agent Directory ───────────────────────────────────────────────────
db.run(`
  CREATE TABLE IF NOT EXISTS agent_directory (
    agent_id TEXT PRIMARY KEY,
    agent_name TEXT,
    model TEXT,
    skills TEXT,
    description TEXT,
    contact_room TEXT,
    status TEXT DEFAULT 'available',
    reputation_score REAL DEFAULT 100.0,
    tasks_completed INTEGER DEFAULT 0,
    last_seen INTEGER,
    registered_at INTEGER
  );
`);

try {
  db.run("CREATE INDEX IF NOT EXISTS idx_agent_dir_skills ON agent_directory(skills);");
  db.run("CREATE INDEX IF NOT EXISTS idx_agent_dir_status ON agent_directory(status);");
} catch (e) {}

export interface AgentProfile {
  agent_id: string;
  agent_name: string;
  model: string;
  skills: string;
  description: string;
  contact_room: string;
  status: string;
  reputation_score: number;
  tasks_completed: number;
  last_seen: number;
  registered_at: number;
}

export function registerAgent(profile: Omit<AgentProfile, "registered_at" | "last_seen" | "reputation_score" | "tasks_completed">): AgentProfile {
  const now = Date.now();
  const full: AgentProfile = { ...profile, reputation_score: 100.0, tasks_completed: 0, last_seen: now, registered_at: now };
  db.prepare(`INSERT OR REPLACE INTO agent_directory
    (agent_id, agent_name, model, skills, description, contact_room, status, reputation_score, tasks_completed, last_seen, registered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(full.agent_id, full.agent_name, full.model, full.skills, full.description, full.contact_room, full.status, full.reputation_score, full.tasks_completed, full.last_seen, full.registered_at);
  return full;
}

export function searchAgents(query: string): AgentProfile[] {
  const q = `%${query.toLowerCase()}%`;
  return db.prepare(`SELECT * FROM agent_directory WHERE
    LOWER(agent_name) LIKE ? OR LOWER(skills) LIKE ? OR LOWER(description) LIKE ? OR LOWER(model) LIKE ?
    ORDER BY reputation_score DESC, tasks_completed DESC LIMIT 20`)
    .all(q, q, q, q) as AgentProfile[];
}

export function getAvailableAgents(): AgentProfile[] {
  const fiveMinutesAgo = Date.now() - 300_000;
  return db.prepare("SELECT * FROM agent_directory WHERE status = 'available' AND last_seen > ? ORDER BY reputation_score DESC")
    .all(fiveMinutesAgo) as AgentProfile[];
}

export function updateAgentStatus(agentId: string, status: string) {
  db.prepare("UPDATE agent_directory SET status = ?, last_seen = ? WHERE agent_id = ?")
    .run(status, Date.now(), agentId);
}

export function incrementAgentTasks(agentId: string) {
  db.prepare("UPDATE agent_directory SET tasks_completed = tasks_completed + 1, last_seen = ? WHERE agent_id = ?")
    .run(Date.now(), agentId);
}

export function getAgentProfile(agentId: string): AgentProfile | null {
  return db.prepare("SELECT * FROM agent_directory WHERE agent_id = ?").get(agentId) as AgentProfile | null;
}

export function getAllAgents(): AgentProfile[] {
  return db.prepare("SELECT * FROM agent_directory ORDER BY reputation_score DESC, last_seen DESC LIMIT 100").all() as AgentProfile[];
}

// ── Pinned Messages ──────────────────────────────────────────────────────────
db.run(`
  CREATE TABLE IF NOT EXISTS pinned_messages (
    room_code TEXT,
    message_id TEXT,
    pinned_by TEXT,
    pinned_at INTEGER,
    PRIMARY KEY(room_code, message_id)
  );
`);

export function pinMessage(roomCode: string, messageId: string, pinnedBy: string) {
  db.prepare("INSERT OR REPLACE INTO pinned_messages (room_code, message_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?)")
    .run(roomCode, messageId, pinnedBy, Date.now());
}

export function unpinMessage(roomCode: string, messageId: string) {
  db.prepare("DELETE FROM pinned_messages WHERE room_code = ? AND message_id = ?")
    .run(roomCode, messageId);
}

export function getPinnedMessages(roomCode: string): Array<{ message_id: string; pinned_by: string; pinned_at: number }> {
  return db.prepare("SELECT message_id, pinned_by, pinned_at FROM pinned_messages WHERE room_code = ? ORDER BY pinned_at DESC")
    .all(roomCode) as any[];
}

// ── File Sharing ─────────────────────────────────────────────────────────────
db.run(`
  CREATE TABLE IF NOT EXISTS shared_files (
    file_id TEXT PRIMARY KEY,
    room_code TEXT,
    uploaded_by TEXT,
    filename TEXT,
    mime_type TEXT,
    size_bytes INTEGER,
    content TEXT,
    description TEXT,
    created_at INTEGER
  );
`);

try {
  db.run("CREATE INDEX IF NOT EXISTS idx_files_room ON shared_files(room_code);");
} catch (e) {}

const MAX_FILE_BYTES = 512 * 1024; // 512KB per file

export function shareFile(
  roomCode: string, uploadedBy: string, filename: string,
  content: string, mimeType: string = "text/plain", description: string = ""
): { ok: boolean; file_id?: string; error?: string } {
  const sizeBytes = new TextEncoder().encode(content).length;
  if (sizeBytes > MAX_FILE_BYTES) return { ok: false, error: "file_too_large_max_512kb" };

  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(roomCode);
  if (!room) return { ok: false, error: "room_not_found" };

  const fileId = crypto.randomUUID();
  const compressed = LZString.compressToEncodedURIComponent(content);

  db.prepare(`INSERT INTO shared_files (file_id, room_code, uploaded_by, filename, mime_type, size_bytes, content, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(fileId, roomCode, uploadedBy, filename, mimeType, sizeBytes, `lz:${compressed}`, description, Date.now());

  // Announce file share as a system message
  appendMessage(roomCode, uploadedBy, `Shared file: ${filename} (${(sizeBytes/1024).toFixed(1)}KB) — ${description || 'no description'}`, undefined, "FILE");

  return { ok: true, file_id: fileId };
}

export function getFile(fileId: string): { ok: boolean; file?: any; error?: string } {
  const row = db.prepare("SELECT * FROM shared_files WHERE file_id = ?").get(fileId) as any;
  if (!row) return { ok: false, error: "file_not_found" };

  const content = row.content.startsWith("lz:")
    ? LZString.decompressFromEncodedURIComponent(row.content.slice(3)) || row.content
    : row.content;

  return { ok: true, file: { ...row, content } };
}

export function getRoomFiles(roomCode: string): Array<{ file_id: string; filename: string; uploaded_by: string; mime_type: string; size_bytes: number; description: string; created_at: number }> {
  return db.prepare("SELECT file_id, filename, uploaded_by, mime_type, size_bytes, description, created_at FROM shared_files WHERE room_code = ? ORDER BY created_at DESC")
    .all(roomCode) as any[];
}

// ── Handoff Protocol ─────────────────────────────────────────────────────────
db.run(`
  CREATE TABLE IF NOT EXISTS handoffs (
    handoff_id TEXT PRIMARY KEY,
    room_code TEXT,
    from_agent TEXT,
    to_agent TEXT,
    summary TEXT,
    context_json TEXT,
    files_changed TEXT,
    decisions_made TEXT,
    blockers TEXT,
    status TEXT DEFAULT 'pending',
    created_at INTEGER,
    accepted_at INTEGER
  );
`);

export interface Handoff {
  handoff_id: string;
  room_code: string;
  from_agent: string;
  to_agent: string;
  summary: string;
  context_json: string;
  files_changed: string;
  decisions_made: string;
  blockers: string;
  status: string;
  created_at: number;
  accepted_at: number | null;
}

export function createHandoff(
  roomCode: string, fromAgent: string, toAgent: string,
  summary: string, context: any, filesChanged: string[] = [],
  decisionsMade: string[] = [], blockers: string[] = []
): Handoff {
  const handoffId = crypto.randomUUID();
  const now = Date.now();

  db.prepare(`INSERT INTO handoffs (handoff_id, room_code, from_agent, to_agent, summary, context_json, files_changed, decisions_made, blockers, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(handoffId, roomCode, fromAgent, toAgent, summary, JSON.stringify(context),
      JSON.stringify(filesChanged), JSON.stringify(decisionsMade), JSON.stringify(blockers), now);

  // Announce handoff
  appendMessage(roomCode, fromAgent, `HANDOFF to ${toAgent}: ${summary}`, toAgent, "HANDOFF");

  return {
    handoff_id: handoffId, room_code: roomCode, from_agent: fromAgent, to_agent: toAgent,
    summary, context_json: JSON.stringify(context), files_changed: JSON.stringify(filesChanged),
    decisions_made: JSON.stringify(decisionsMade), blockers: JSON.stringify(blockers),
    status: "pending", created_at: now, accepted_at: null,
  };
}

export function acceptHandoff(handoffId: string, agentName: string): { ok: boolean; error?: string } {
  const h = db.prepare("SELECT * FROM handoffs WHERE handoff_id = ?").get(handoffId) as Handoff | null;
  if (!h) return { ok: false, error: "handoff_not_found" };
  if (h.to_agent !== agentName) return { ok: false, error: "not_assigned_to_you" };

  db.prepare("UPDATE handoffs SET status = 'accepted', accepted_at = ? WHERE handoff_id = ?")
    .run(Date.now(), handoffId);

  appendMessage(h.room_code, agentName, `Accepted handoff from ${h.from_agent}: ${h.summary}`, h.from_agent, "HANDOFF");
  return { ok: true };
}

export function getHandoff(handoffId: string): Handoff | null {
  return db.prepare("SELECT * FROM handoffs WHERE handoff_id = ?").get(handoffId) as Handoff | null;
}

export function getAgentHandoffs(agentName: string): Handoff[] {
  return db.prepare("SELECT * FROM handoffs WHERE to_agent = ? ORDER BY created_at DESC")
    .all(agentName) as Handoff[];
}

// ── Room Templates ───────────────────────────────────────────────────────────
db.run(`
  CREATE TABLE IF NOT EXISTS room_templates (
    template_id TEXT PRIMARY KEY,
    name TEXT,
    description TEXT,
    roles TEXT,
    message_types TEXT,
    welcome_message TEXT,
    icon TEXT,
    created_by TEXT,
    created_at INTEGER
  );
`);

// Seed default templates
const defaultTemplates = [
  { id: "code-review", name: "Code Review", desc: "Structured code review with reviewer and author roles",
    roles: "author,reviewer,approver", types: "REVIEW,APPROVE,REQUEST_CHANGES,COMMENT",
    welcome: "Code Review room active. Author: share your diff. Reviewers: provide feedback.", icon: "🔍" },
  { id: "sprint-planning", name: "Sprint Planning", desc: "Sprint planning with task breakdown and estimation",
    roles: "lead,developer,qa,designer", types: "TASK,ESTIMATE,PRIORITY,BLOCKER",
    welcome: "Sprint Planning room. Lead: share objectives. Team: break down and estimate.", icon: "📋" },
  { id: "debugging", name: "Debugging", desc: "Collaborative debugging with hypothesis tracking",
    roles: "investigator,helper,observer", types: "HYPOTHESIS,EVIDENCE,ROOT_CAUSE,FIX",
    welcome: "Debug room active. State the bug, share logs, form hypotheses.", icon: "🐛" },
  { id: "brainstorm", name: "Brainstorm", desc: "Open brainstorming with idea voting",
    roles: "facilitator,contributor", types: "IDEA,VOTE,BUILD_ON,CHALLENGE",
    welcome: "Brainstorm room. All ideas welcome. No judgment. Build on each other.", icon: "💡" },
  { id: "deployment", name: "Deployment", desc: "Coordinated deployment with rollback tracking",
    roles: "deployer,monitor,approver", types: "DEPLOY,VERIFY,ROLLBACK,APPROVE,ALERT",
    welcome: "Deployment room. Deployer: state the plan. Monitor: watch metrics.", icon: "🚀" },
  { id: "incident", name: "Incident Response", desc: "Incident management with severity and timeline tracking",
    roles: "incident_commander,responder,communicator", types: "ALERT,UPDATE,MITIGATION,RESOLVED,POSTMORTEM",
    welcome: "INCIDENT ROOM. Commander: state severity and impact. Responders: check in.", icon: "🚨" },
];

for (const t of defaultTemplates) {
  db.prepare(`INSERT OR IGNORE INTO room_templates (template_id, name, description, roles, message_types, welcome_message, icon, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'system', ?)`)
    .run(t.id, t.name, t.desc, t.roles, t.types, t.welcome, t.icon, Date.now());
}

export function getTemplates(): Array<{ template_id: string; name: string; description: string; roles: string; icon: string }> {
  return db.prepare("SELECT template_id, name, description, roles, icon FROM room_templates ORDER BY name").all() as any[];
}

export function getTemplate(templateId: string): any {
  return db.prepare("SELECT * FROM room_templates WHERE template_id = ?").get(templateId);
}

export function createRoomFromTemplate(templateId: string, creatorName: string): { ok: boolean; room_code?: string; template?: any; error?: string } {
  const template = getTemplate(templateId);
  if (!template) return { ok: false, error: "template_not_found" };

  const roomCode = createRoom();
  joinRoom(roomCode, creatorName);

  // Send welcome message
  appendMessage(roomCode, "system", template.welcome_message, undefined, "SYSTEM");

  return { ok: true, room_code: roomCode, template };
}

// ── Reputation & Productivity Leaderboard ────────────────────────────────────
db.run(`
  CREATE TABLE IF NOT EXISTS agent_stats (
    agent_name TEXT PRIMARY KEY,
    messages_sent INTEGER DEFAULT 0,
    tasks_completed INTEGER DEFAULT 0,
    handoffs_completed INTEGER DEFAULT 0,
    files_shared INTEGER DEFAULT 0,
    reactions_given INTEGER DEFAULT 0,
    reactions_received INTEGER DEFAULT 0,
    lines_of_code INTEGER DEFAULT 0,
    commits_pushed INTEGER DEFAULT 0,
    bugs_fixed INTEGER DEFAULT 0,
    reviews_done INTEGER DEFAULT 0,
    avg_response_ms REAL DEFAULT 0,
    uptime_minutes INTEGER DEFAULT 0,
    reputation REAL DEFAULT 100.0,
    streak_days INTEGER DEFAULT 0,
    first_seen INTEGER,
    last_active INTEGER
  );
`);

// Migration for new columns
const newStatCols = [
  "reactions_given INTEGER DEFAULT 0",
  "reactions_received INTEGER DEFAULT 0",
  "lines_of_code INTEGER DEFAULT 0",
  "commits_pushed INTEGER DEFAULT 0",
  "bugs_fixed INTEGER DEFAULT 0",
  "reviews_done INTEGER DEFAULT 0",
  "streak_days INTEGER DEFAULT 0",
];
for (const col of newStatCols) {
  try { db.run(`ALTER TABLE agent_stats ADD COLUMN ${col};`); } catch (e) {}
}

export function trackAgentActivity(agentName: string, activityType: string, value: number = 1) {
  const now = Date.now();
  // Upsert agent stats
  db.prepare(`INSERT INTO agent_stats (agent_name, messages_sent, tasks_completed, handoffs_completed, files_shared, reactions_given, reactions_received, lines_of_code, commits_pushed, bugs_fixed, reviews_done, first_seen, last_active)
    VALUES (?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?)
    ON CONFLICT(agent_name) DO UPDATE SET last_active = ?`)
    .run(agentName, now, now, now);

  const colMap: Record<string, string> = {
    message: "messages_sent",
    task_complete: "tasks_completed",
    handoff: "handoffs_completed",
    file_share: "files_shared",
    reaction_given: "reactions_given",
    reaction_received: "reactions_received",
    lines_of_code: "lines_of_code",
    commit: "commits_pushed",
    bug_fix: "bugs_fixed",
    review: "reviews_done",
  };

  const col = colMap[activityType];
  if (col) {
    db.prepare(`UPDATE agent_stats SET ${col} = ${col} + ? WHERE agent_name = ?`).run(value, agentName);
  }

  // Reputation boosts for productive work
  const repBoosts: Record<string, number> = {
    task_complete: 5, handoff: 3, file_share: 2, commit: 4, bug_fix: 6, review: 3
  };
  if (repBoosts[activityType]) {
    db.prepare("UPDATE agent_stats SET reputation = MIN(reputation + ?, 500) WHERE agent_name = ?")
      .run(repBoosts[activityType], agentName);
  }
}

export function getLeaderboard(limit: number = 20): any[] {
  const rows = db.prepare(`SELECT agent_name, messages_sent, tasks_completed, handoffs_completed, files_shared,
    reactions_given, reactions_received, lines_of_code, commits_pushed, bugs_fixed, reviews_done,
    reputation, streak_days, first_seen, last_active,
    (messages_sent + tasks_completed * 15 + handoffs_completed * 5 + files_shared * 3 +
     commits_pushed * 25 + bugs_fixed * 20 + reviews_done * 8 + lines_of_code / 5) as score,
    CASE
      WHEN (tasks_completed + commits_pushed + bugs_fixed) >= 20 THEN 'legendary'
      WHEN (tasks_completed + commits_pushed + bugs_fixed) >= 10 THEN 'elite'
      WHEN (tasks_completed + commits_pushed + bugs_fixed) >= 5 THEN 'veteran'
      WHEN messages_sent >= 10 THEN 'active'
      ELSE 'rookie'
    END as rank_title
    FROM agent_stats ORDER BY score DESC LIMIT ?`)
    .all(limit) as any[];

  return rows.map((r: any) => {
    const badges: string[] = [];
    if (r.messages_sent >= 20) badges.push("The Communicator");
    if (r.bugs_fixed >= 3) badges.push("The Exterminator");
    if (r.commits_pushed >= 5) badges.push("The Shipper");
    if (r.handoffs_completed >= 3) badges.push("Team Player");
    if (r.files_shared >= 5) badges.push("Knowledge Sharer");
    if (r.reviews_done >= 3) badges.push("Code Guardian");
    if (r.tasks_completed >= 5) badges.push("Task Machine");
    if (r.reputation >= 200) badges.push("Trusted");
    if (r.score >= 50) badges.push("MVP");
    return { ...r, badges };
  });
}

export function getProductivityReport(agentName: string): any {
  const stats = db.prepare("SELECT * FROM agent_stats WHERE agent_name = ?").get(agentName) as any;
  if (!stats) return null;

  const activeMinutes = stats.last_active && stats.first_seen
    ? Math.floor((stats.last_active - stats.first_seen) / 60000)
    : 0;

  return {
    ...stats,
    active_minutes: activeMinutes,
    productivity_score: stats.tasks_completed * 10 + stats.commits_pushed * 8 +
      stats.bugs_fixed * 12 + stats.files_shared * 3 + stats.lines_of_code / 10,
    communication_score: stats.messages_sent + stats.reactions_given * 2 + stats.handoffs_completed * 5,
    total_score: stats.messages_sent + stats.tasks_completed * 10 + stats.handoffs_completed * 5 +
      stats.files_shared * 3 + stats.commits_pushed * 8 + stats.bugs_fixed * 12 + stats.reviews_done * 6,
  };
}

export function getAgentStats(agentName: string): any {
  return getProductivityReport(agentName);
}

// ── Persistent Rate Limiting ──────────────────────────────────────────────────

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

// ── Message Search ───────────────────────────────────────────────────────────
export function searchMessages(roomCode: string, query: string, limit: number = 50): Message[] {
  // Fetch all messages for the room (content is LZ-compressed, so SQL LIKE won't work)
  const rows = db.prepare(`
    SELECT id, sender as 'from', recipient as 'to', content, timestamp as ts, msg_type as type
    FROM messages WHERE room_code = ?
    ORDER BY timestamp DESC
  `).all(roomCode) as any[];

  const lowerQuery = query.toLowerCase();
  const results: Message[] = [];

  for (const m of rows) {
    const plainContent = m.content.startsWith("lz:")
      ? LZString.decompressFromEncodedURIComponent(m.content.slice(3)) || m.content
      : m.content;

    const fromMatch = m.from?.toLowerCase().includes(lowerQuery);
    const contentMatch = plainContent.toLowerCase().includes(lowerQuery);

    if (fromMatch || contentMatch) {
      results.push({ ...m, content: plainContent });
      if (results.length >= limit) break;
    }
  }

  return results;
}

// ── Scheduled Messages ───────────────────────────────────────────────────────
db.run(`
  CREATE TABLE IF NOT EXISTS scheduled_messages (
    schedule_id TEXT PRIMARY KEY,
    room_code TEXT,
    sender TEXT,
    content TEXT,
    msg_type TEXT DEFAULT 'BROADCAST',
    recipient TEXT,
    send_at INTEGER,
    sent INTEGER DEFAULT 0,
    created_at INTEGER
  );
`);

export function scheduleMessage(roomCode: string, sender: string, content: string, sendAt: number, recipient?: string, msgType: string = "BROADCAST"): string {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO scheduled_messages (schedule_id, room_code, sender, content, msg_type, recipient, send_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, roomCode, sender, content, msgType, recipient || null, sendAt, Date.now());
  return id;
}

export function processScheduledMessages(): number {
  const now = Date.now();
  const due = db.prepare("SELECT * FROM scheduled_messages WHERE sent = 0 AND send_at <= ?").all(now) as any[];

  for (const msg of due) {
    appendMessage(msg.room_code, msg.sender, msg.content, msg.recipient, msg.msg_type);
    db.prepare("UPDATE scheduled_messages SET sent = 1 WHERE schedule_id = ?").run(msg.schedule_id);
  }
  return due.length;
}

export function getScheduledMessages(roomCode: string): any[] {
  return db.prepare("SELECT schedule_id, sender, content, msg_type, recipient, send_at, created_at FROM scheduled_messages WHERE room_code = ? AND sent = 0 ORDER BY send_at ASC")
    .all(roomCode) as any[];
}

export function cancelScheduledMessage(scheduleId: string): boolean {
  const result = db.prepare("DELETE FROM scheduled_messages WHERE schedule_id = ? AND sent = 0").run(scheduleId);
  return result.changes > 0;
}

// ── Agent personality persistence ────────────────────────────────────────────

export function savePersonality(name: string, personality: string, systemPrompt: string, skills: string, model?: string, tool?: string): void {
  const now = Date.now();
  db.prepare(`INSERT INTO agent_personalities (name, personality, system_prompt, skills, model, tool, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      personality = excluded.personality,
      system_prompt = excluded.system_prompt,
      skills = excluded.skills,
      model = COALESCE(excluded.model, model),
      tool = COALESCE(excluded.tool, tool),
      updated_at = excluded.updated_at`)
    .run(name, personality, systemPrompt, skills, model || "", tool || "", now, now);
}

export function getPersonality(name: string): { name: string; personality: string; system_prompt: string; skills: string; model: string; tool: string; updated_at: number } | null {
  return db.prepare("SELECT * FROM agent_personalities WHERE name = ?").get(name) as any || null;
}

export function getAllPersonalities(): any[] {
  return db.prepare("SELECT name, personality, skills, model, tool, updated_at FROM agent_personalities ORDER BY updated_at DESC").all() as any[];
}

// Generate a CLAUDE.md-compatible identity block for an agent
export function generateIdentityBlock(name: string): string {
  const p = getPersonality(name);
  if (!p) return `# ${name}\nNo saved personality. Use /api/personality to save one.`;
  const modelLine = p.model ? `\nModel: ${p.model}` : "";
  const toolLine = p.tool ? `\nTool: ${p.tool}` : "";
  return `# Agent Identity: ${name}${modelLine}${toolLine}\n\n${p.personality}\n\nSkills: ${p.skills}\n\n## System Prompt\n${p.system_prompt}\n\n---\nSaved at: ${new Date(p.updated_at).toISOString()}`;
}

// ── Run seeds after all tables are created ───────────────────────────────────
seedDefaultRooms();
