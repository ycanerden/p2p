import { Database } from "bun:sqlite";
import { EventEmitter } from "events";

// Persistent SQLite store using Bun's native driver
// Rooms and messages will survive server restarts
const db = new Database("mesh.db", { create: true });

// Event emitter for real-time updates (SSE)
export const messageEvents = new EventEmitter();

// Initialize tables
db.run(`
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    last_activity INTEGER
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_code TEXT,
    sender TEXT,
    content TEXT,
    timestamp INTEGER,
    FOREIGN KEY(room_code) REFERENCES rooms(code)
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    room_code TEXT,
    name TEXT,
    cursor INTEGER DEFAULT 0,
    last_seen INTEGER,
    PRIMARY KEY(room_code, name),
    FOREIGN KEY(room_code) REFERENCES rooms(code)
  );
`);

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

export interface Message {
  id: string;
  from: string;
  ts: number;
  content: string;
}

const MAX_MESSAGE_BYTES = 10 * 1024; // 10KB
const ROOM_TTL_MS = 72 * 60 * 60 * 1000; // 72h

// ── Room management ──────────────────────────────────────────────────────────

export function createRoom(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code: string;
  const checkStmt = db.prepare("SELECT 1 FROM rooms WHERE code = ?");
  
  do {
    code = Array.from(
      { length: 6 },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (checkStmt.get(code));

  db.prepare("INSERT INTO rooms (code, last_activity) VALUES (?, ?)").run(code, Date.now());
  return code;
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

// ── MCP tool operations ───────────────────────────────────────────────────────

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };

export function appendMessage(
  code: string,
  from: string,
  content: string
): Ok<{ id: string }> | Err {
  if (new TextEncoder().encode(content).length > MAX_MESSAGE_BYTES) {
    return { ok: false, error: "message_too_large" };
  }
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return { ok: false, error: "room_expired_or_not_found" };

  const id = crypto.randomUUID();
  const timestamp = Date.now();
  db.prepare("INSERT INTO messages (id, room_code, sender, content, timestamp) VALUES (?, ?, ?, ?, ?)")
    .run(id, code, from, content, timestamp);
  
  db.prepare("UPDATE rooms SET last_activity = ? WHERE code = ?").run(Date.now(), code);

  // Emit event for real-time listeners (SSE)
  messageEvents.emit("message", {
    room_code: code,
    message: { id, from: from, content, ts: timestamp }
  });

  return { ok: true, id };
}

export function getMessages(
  code: string,
  name: string
): Ok<{ messages: Message[] }> | Err {
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return { ok: false, error: "room_expired_or_not_found" };

  const user = db.prepare("SELECT cursor FROM users WHERE room_code = ? AND name = ?").get(code, name) as { cursor: number } | undefined;
  if (!user) return { ok: false, error: "not_in_room" };

  const rows = db.prepare("SELECT id, sender as 'from', content, timestamp as ts FROM messages WHERE room_code = ? LIMIT -1 OFFSET ?")
    .all(code, user.cursor) as Message[];

  // Filter out own messages
  const filtered = rows.filter(m => m.from !== name);

  // Advance cursor to current message count
  const countRow = db.prepare("SELECT COUNT(*) as count FROM messages WHERE room_code = ?").get(code) as { count: number };
  db.prepare("UPDATE users SET cursor = ?, last_seen = ? WHERE room_code = ? AND name = ?")
    .run(countRow.count, Date.now(), code, name);

  db.prepare("UPDATE rooms SET last_activity = ? WHERE code = ?").run(Date.now(), code);
  return { ok: true, messages: filtered };
}

export function getAllMessages(
  code: string
): Ok<{ messages: Message[] }> | Err {
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return { ok: false, error: "room_expired_or_not_found" };
  
  const messages = db.prepare("SELECT id, sender as 'from', content, timestamp as ts FROM messages WHERE room_code = ?")
    .all(code) as Message[];
    
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
