import Database from "better-sqlite3";

// Persistent SQLite store
// Rooms and messages will survive server restarts
const db = new Database("mesh.db");

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    last_activity INTEGER
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_code TEXT,
    sender TEXT,
    content TEXT,
    timestamp INTEGER,
    FOREIGN KEY(room_code) REFERENCES rooms(code)
  );

  CREATE TABLE IF NOT EXISTS users (
    room_code TEXT,
    name TEXT,
    cursor INTEGER DEFAULT 0,
    last_seen INTEGER,
    PRIMARY KEY(room_code, name),
    FOREIGN KEY(room_code) REFERENCES rooms(code)
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

export function joinRoom(code: string, name: string): boolean {
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return false;

  const user = db.prepare("SELECT 1 FROM users WHERE room_code = ? AND name = ?").get(code, name);
  if (!user) {
    db.prepare("INSERT INTO users (room_code, name, cursor, last_seen) VALUES (?, ?, 0, ?)")
      .run(code, name, Date.now());
  } else {
    db.prepare("UPDATE users SET last_seen = ? WHERE room_code = ? AND name = ?")
      .run(Date.now(), code, name);
  }
  
  db.prepare("UPDATE rooms SET last_activity = ? WHERE code = ?").run(Date.now(), code);
  return true;
}

export function getRoomCount(): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM rooms").get() as { count: number };
  return row.count;
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
  if (!room) return { ok: false, error: "room_expired_server_restarted" };

  const id = crypto.randomUUID();
  db.prepare("INSERT INTO messages (id, room_code, sender, content, timestamp) VALUES (?, ?, ?, ?, ?)")
    .run(id, code, from, content, Date.now());
  
  db.prepare("UPDATE rooms SET last_activity = ? WHERE code = ?").run(Date.now(), code);
  return { ok: true, id };
}

export function getMessages(
  code: string,
  name: string
): Ok<{ messages: Message[] }> | Err {
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return { ok: false, error: "room_expired_server_restarted" };

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
  if (!room) return { ok: false, error: "room_expired_server_restarted" };
  
  const messages = db.prepare("SELECT id, sender as 'from', content, timestamp as ts FROM messages WHERE room_code = ?")
    .all(code) as Message[];
    
  return { ok: true, messages };
}

export function getRoomStatus(
  code: string,
  name: string
): Ok<{ connected: boolean; partners: string[]; message_count: number }> | Err {
  const room = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  if (!room) return { ok: false, error: "room_expired_server_restarted" };

  const partners = db.prepare("SELECT name FROM users WHERE room_code = ? AND name != ?")
    .all(code, name).map((r: any) => r.name);

  const countRow = db.prepare("SELECT COUNT(*) as count FROM messages WHERE room_code = ?").get(code) as { count: number };

  return {
    ok: true,
    connected: partners.length > 0,
    partners,
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
  
  return expired.length;
}
