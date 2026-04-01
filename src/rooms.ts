
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
try { db.run("ALTER TABLE rooms ADD COLUMN telegram_chat_id TEXT DEFAULT NULL;"); } catch (e) {}
try { db.run("ALTER TABLE rooms ADD COLUMN telegram_token TEXT DEFAULT NULL;"); } catch (e) {}
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

// Waitlist for YC launch
db.run(`CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  use_case TEXT,
  signed_up_at INTEGER NOT NULL
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

// ── Google OAuth identity ─────────────────────────────────────────────────────
// Activated when GOOGLE_CLIENT_ID env var is set in Railway
db.run(`CREATE TABLE IF NOT EXISTS google_accounts (
  google_id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  picture TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);`);

db.run(`CREATE TABLE IF NOT EXISTS google_sessions (
  token TEXT PRIMARY KEY,
  google_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(google_id) REFERENCES google_accounts(google_id)
);`);

try { db.run("CREATE INDEX IF NOT EXISTS idx_sessions_google_id ON google_sessions(google_id);"); } catch(e) {}

export interface GoogleAccount {
  google_id: string;
  email: string;
  name: string;
  picture: string;
  created_at: number;
  last_seen: number;
}

// Upsert a Google account after token verification
export function upsertGoogleAccount(account: Omit<GoogleAccount, 'created_at' | 'last_seen'>): GoogleAccount {
  const now = Date.now();
  db.prepare(`
    INSERT INTO google_accounts (google_id, email, name, picture, created_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(google_id) DO UPDATE SET
      email=excluded.email, name=excluded.name, picture=excluded.picture, last_seen=excluded.last_seen
  `).run(account.google_id, account.email, account.name, account.picture, now, now);
  return db.prepare("SELECT * FROM google_accounts WHERE google_id = ?").get(account.google_id) as GoogleAccount;
}

// Create a 30-day session token for an authenticated Google account
export function createGoogleSession(google_id: string): string {
  const token = generateSecureToken();
  const now = Date.now();
  const expires = now + 30 * 24 * 60 * 60 * 1000; // 30 days
  db.prepare("INSERT INTO google_sessions (token, google_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(token, google_id, now, expires);
  return token;
}

// Validate a session token — returns the account or null if invalid/expired
export function getAccountBySession(token: string): GoogleAccount | null {
  const session = db.prepare(
    "SELECT s.*, a.* FROM google_sessions s JOIN google_accounts a ON s.google_id = a.google_id WHERE s.token = ? AND s.expires_at > ?"
  ).get(token, Date.now()) as any;
  if (!session) return null;
  return {
    google_id: session.google_id,
    email: session.email,
    name: session.name,
    picture: session.picture,
    created_at: session.created_at,
    last_seen: session.last_seen,
  };
}

// Invalidate a session
export function deleteGoogleSession(token: string): void {
  db.prepare("DELETE FROM google_sessions WHERE token = ?").run(token);
}

// Clean up expired sessions (call periodically)
export function cleanExpiredSessions(): void {
  db.prepare("DELETE FROM google_sessions WHERE expires_at < ?").run(Date.now());
}

// ── Stripe subscriptions ──────────────────────────────────────────────────────
// Activated when STRIPE_WEBHOOK_SECRET env var is set.
db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_subscription_id TEXT UNIQUE,
  stripe_customer_id TEXT NOT NULL,
  email TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'pro',
  status TEXT NOT NULL DEFAULT 'active',
  room_code TEXT,
  created_at INTEGER NOT NULL,
  current_period_end INTEGER
);`);

try { db.run("CREATE INDEX IF NOT EXISTS idx_sub_email ON subscriptions(email);"); } catch(e) {}
try { db.run("CREATE INDEX IF NOT EXISTS idx_sub_customer ON subscriptions(stripe_customer_id);"); } catch(e) {}
try { db.run("ALTER TABLE subscriptions ADD COLUMN room_password TEXT DEFAULT NULL;"); } catch(e) {}

export interface Subscription {
  id: number;
  stripe_subscription_id: string | null;
  stripe_customer_id: string;
  email: string;
  plan: string;
  status: string;
  room_code: string | null;
  created_at: number;
  current_period_end: number | null;
}

export function upsertSubscription(sub: Omit<Subscription, 'id' | 'created_at'> & { room_password?: string | null }): void {
  db.prepare(`
    INSERT INTO subscriptions (stripe_subscription_id, stripe_customer_id, email, plan, status, room_code, created_at, current_period_end, room_password)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stripe_subscription_id) DO UPDATE SET
      status=excluded.status, current_period_end=excluded.current_period_end,
      room_code=excluded.room_code, email=excluded.email, room_password=excluded.room_password
  `).run(sub.stripe_subscription_id, sub.stripe_customer_id, sub.email, sub.plan, sub.status, sub.room_code, Date.now(), sub.current_period_end ?? null, sub.room_password ?? null);
}

export function getSubscriptionByEmail(email: string): Subscription | null {
  return db.prepare(
    "SELECT * FROM subscriptions WHERE email = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
  ).get(email) as Subscription | null;
}

export function getSubscriptionByRoom(roomCode: string): Subscription | null {
  return db.prepare(
    "SELECT * FROM subscriptions WHERE room_code = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
  ).get(roomCode) as Subscription | null;
}

export function cancelSubscription(stripeSubscriptionId: string): void {
  db.prepare("UPDATE subscriptions SET status = 'cancelled' WHERE stripe_subscription_id = ?").run(stripeSubscriptionId);
}

export function getSubscriptionStats(): { total: number; active: number; pro: number; team: number } {
  const total = (db.prepare("SELECT COUNT(*) as n FROM subscriptions").get() as any).n;
  const active = (db.prepare("SELECT COUNT(*) as n FROM subscriptions WHERE status = 'active'").get() as any).n;
  const pro = (db.prepare("SELECT COUNT(*) as n FROM subscriptions WHERE status = 'active' AND plan = 'pro'").get() as any).n;
  const team = (db.prepare("SELECT COUNT(*) as n FROM subscriptions WHERE status = 'active' AND plan = 'team'").get() as any).n;
  return { total, active, pro, team };
}

// ── Paid room provisioning ────────────────────────────────────────────────────
export function provisionPaidRoom(
  email: string,
  plan: string,
  roomCode?: string | null
): { room_code: string; admin_token: string; password: string } {
  // Create room if none specified, or use existing
  let code: string;
  let adminToken: string;

  if (roomCode) {
    // Use the room they specified at checkout
    const existing = db.prepare("SELECT admin_token FROM rooms WHERE code = ?").get(roomCode) as any;
    if (existing) {
      code = roomCode;
      adminToken = existing.admin_token || generateSecureToken();
      if (!existing.admin_token) {
        db.prepare("UPDATE rooms SET admin_token = ? WHERE code = ?").run(adminToken, code);
      }
    } else {
      // Room doesn't exist, create it
      const room = createRoom(false);
      code = room.code;
      adminToken = room.admin_token;
    }
  } else {
    // No room specified, create a new one
    const room = createRoom(false);
    code = room.code;
    adminToken = room.admin_token;
  }

  // Make room private with a generated password
  const password = crypto.randomBytes(4).toString("hex"); // 8-char hex password
  setRoomPassword(code, password);

  // Set agent limits based on plan
  const agentLimit = plan === "team" ? 50 : 20;
  try {
    db.prepare("ALTER TABLE rooms ADD COLUMN agent_limit INTEGER DEFAULT 0;").run();
  } catch (e) {} // column may already exist
  db.prepare("UPDATE rooms SET agent_limit = ? WHERE code = ?").run(agentLimit, code);

  // Send welcome message
  appendMessage(code, "system",
    `Room activated — ${plan} plan (${email}). Private room with password protection. ${agentLimit} agent slots available.`,
    undefined, "SYSTEM"
  );

  console.log(`[billing] Provisioned ${plan} room ${code} for ${email} (password: ${password.slice(0, 2)}***)`);
  return { room_code: code, admin_token: adminToken, password };
}

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
  reply_to?: string;
  reactions?: { agent_name: string; emoji: string }[];
}

const MAX_MESSAGE_BYTES = 10 * 1024; // 10KB
const ROOM_TTL_MS = 72 * 60 * 60 * 1000; // 72h

// ── Task Assignments ─────────────────────────────────────────────────────────
db.run(`
  CREATE TABLE IF NOT EXISTS room_assignments (
    task_id TEXT PRIMARY KEY,
    room_code TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    task_title TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    note TEXT,
    assigned_at INTEGER NOT NULL,
    updated_at INTEGER,
    due_date INTEGER,
    FOREIGN KEY(room_code) REFERENCES rooms(code)
  );
`);

try { db.run("CREATE INDEX IF NOT EXISTS idx_assignments_room ON room_assignments(room_code);"); } catch (e) {}
try { db.run("CREATE INDEX IF NOT EXISTS idx_assignments_agent ON room_assignments(agent_name);"); } catch (e) {}

export interface TaskAssignment {
  task_id: string;
  room_code: string;
  agent_name: string;
  task_title: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
  note?: string;
  assigned_at: number;
  updated_at?: number;
  due_date?: number;
}

export function assignTask(
  roomCode: string,
  agentName: string,
  taskTitle: string,
  dueDate?: number
): TaskAssignment {
  const taskId = `task_${crypto.randomBytes(6).toString('hex')}`;
  const now = Date.now();
  db.prepare(`
    INSERT INTO room_assignments (task_id, room_code, agent_name, task_title, assigned_at, due_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(taskId, roomCode, agentName, taskTitle, now, dueDate || null);

  appendMessage(roomCode, 'system', `TASK ASSIGNED to @agent:${agentName}: ${taskTitle}`, agentName, 'TASK');

  return { task_id: taskId, room_code: roomCode, agent_name: agentName, task_title: taskTitle, status: 'pending', assigned_at: now, due_date: dueDate };
}

export function updateTaskStatus(
  roomCode: string,
  agentName: string,
  taskId: string,
  status: 'in_progress' | 'done' | 'blocked',
  note?: string
): void {
  db.prepare(
    "UPDATE room_assignments SET status = ?, note = ?, updated_at = ? WHERE task_id = ? AND room_code = ?"
  ).run(status, note || null, Date.now(), taskId, roomCode);
  
  const task = db.prepare("SELECT task_title FROM room_assignments WHERE task_id = ?").get(taskId) as { task_title: string };
  if (task) {
    const statusEmoji = { done: '✅', in_progress: '⏳', blocked: '🛑' }[status];
    appendMessage(roomCode, 'system', `${statusEmoji} TASK UPDATE by @agent:${agentName}: ${task.task_title} → ${status.toUpperCase()}`, undefined, 'TASK');
  }
}

export function getRoomTasks(roomCode: string): TaskAssignment[] {
  return db
    .prepare("SELECT * FROM room_assignments WHERE room_code = ? ORDER BY assigned_at DESC")
    .all(roomCode) as TaskAssignment[];
}

export function getAgentTasks(agentName: string): TaskAssignment[] {
  return db
    .prepare("SELECT * FROM room_assignments WHERE agent_name = ? ORDER BY assigned_at DESC")
    .all(agentName) as TaskAssignment[];
}

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

export function setTelegramConfig(roomCode: string, token: string, chatId: string): void {
  db.prepare("UPDATE rooms SET telegram_token = ?, telegram_chat_id = ? WHERE code = ?").run(token, chatId, roomCode);
}

export function getTelegramConfig(roomCode: string): { token: string | null; chatId: string | null } {
  const row = db.prepare("SELECT telegram_token, telegram_chat_id FROM rooms WHERE code = ?").get(roomCode) as any;
  return { token: row?.telegram_token || null, chatId: row?.telegram_chat_id || null };
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

export function getActiveRooms(): { code: string; agent_count: number; message_count: number; last_active: number; mode?: string; project_title?: string; deadline?: number; total_deliverables?: number; done_deliverables?: number }[] {
  const rows = db.prepare(`
    SELECT r.code, r.mode, r.project_title, r.deadline,
      COUNT(DISTINCT CASE WHEN p.agent_name NOT IN ('Pulse','Scout','Archie','Viewer','demo-viewer','office-viewer','team-viewer','Atlas','Nova','Echo') THEN p.agent_name END) as agent_count,
      COUNT(DISTINCT CASE WHEN m.sender NOT IN ('Pulse','Scout','Archie','Viewer','system','Atlas','Nova','Echo') THEN m.id END) as message_count,
      MAX(COALESCE(p.last_heartbeat, 0)) as last_active,
      (SELECT COUNT(*) FROM project_deliverables WHERE room_code = r.code) as total_deliverables,
      (SELECT COUNT(*) FROM project_deliverables WHERE room_code = r.code AND status = 'done') as done_deliverables
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

export function getPublicRoomActivity(limit: number = 50): any[] {
  return db.prepare(`
    SELECT m.id, m.room_code, m.sender as 'from', SUBSTR(m.content, 1, 200) as content, m.timestamp as ts, m.msg_type as type
    FROM messages m
    JOIN rooms r ON m.room_code = r.code
    WHERE r.is_private = 0
    ORDER BY m.timestamp DESC
    LIMIT ?
  `).all(limit) as any[];
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

  // Track metric
  trackMetric("message_sent", code, from);

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
  // Batch-load reactions for all messages in one query (avoids N+1)
  const reactionsBatch = getMessageReactionsBatch(filteredRows.map(m => m.id));
  const filtered = filteredRows
    .map(m => {
      const decompressed = m.content.startsWith("lz:") ? LZString.decompressFromEncodedURIComponent(m.content.slice(3)) || m.content : m.content;
      const mentionMatches = decompressed.match(/@([\w\s.-]+?)(?=\s|[^a-zA-Z0-9._\s-]|$)/g);
      const mentions = mentionMatches ? [...new Set(mentionMatches.map((m: string) => m.slice(1).trim()))] : undefined;
      const reactions = reactionsBatch.get(m.id) || [];
      return {
        id: m.id,
        from: m.from,
        to: m.to,
        ts: m.ts,
        content: decompressed,
        type: m.type,
        reply_to: m.reply_to,
        ...(mentions?.length ? { mentions } : {}),
        ...(reactions.length ? { reactions } : {})
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

  // Batch-load reactions for all messages in one query (avoids N+1)
  const reactionsBatchAll = getMessageReactionsBatch(rows.map(m => m.id));
  const messages = rows
    .map(m => {
      const decompressed = m.content.startsWith("lz:") ? LZString.decompressFromEncodedURIComponent(m.content.slice(3)) || m.content : m.content;
      const reactions = reactionsBatchAll.get(m.id) || [];
      return {
        ...m,
        content: decompressed,
        ...(reactions.length ? { reactions } : {})
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
// ── Message Admin ─────────────────────────────────────────────────────────────

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

// Batch version to avoid N+1 queries when loading message lists
export function getMessageReactionsBatch(messageIds: string[]): Map<string, Array<{ agent_name: string; emoji: string; created_at: number }>> {
  const result = new Map<string, Array<{ agent_name: string; emoji: string; created_at: number }>>();
  if (messageIds.length === 0) return result;
  const placeholders = messageIds.map(() => "?").join(",");
  const rows = db.prepare(`SELECT message_id, agent_name, emoji, created_at FROM reactions WHERE message_id IN (${placeholders})`)
    .all(...messageIds) as any[];
  for (const row of rows) {
    if (!result.has(row.message_id)) result.set(row.message_id, []);
    result.get(row.message_id)!.push({ agent_name: row.agent_name, emoji: row.emoji, created_at: row.created_at });
  }
  return result;
}

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

  // Forward to Telegram if configured
  if (event === "message") {
    const config = getTelegramConfig(roomCode);
    if (config.token && config.chatId) {
      const msg = payload.message;
      // Don't echo back messages from Telegram
      if (msg.from?.includes("(Telegram)")) return;

      const formatted = `<b>${msg.from}</b>: ${msg.content || ""}`;
      try {
        fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: config.chatId,
            text: formatted,
            parse_mode: "HTML",
          }),
        }).catch(() => {});
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
  db.prepare(`
    INSERT OR REPLACE INTO agent_directory 
    (agent_id, agent_name, model, skills, description, contact_room, status, reputation_score, tasks_completed, last_seen, registered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(full.agent_id, full.agent_name, full.model, full.skills, full.description, full.contact_room, full.status, full.reputation_score, full.tasks_completed, full.last_seen, full.registered_at);
  return full;
}

export function getAllAgentProfiles(): AgentProfile[] {
  return db.prepare("SELECT * FROM agent_directory ORDER BY reputation_score DESC").all() as AgentProfile[];
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

export function getThread(roomCode: string, messageId: string): any[] {
  return db.prepare(`
    SELECT id, sender as 'from', recipient as 'to', content, timestamp as ts, msg_type as 'type', reply_to
    FROM messages
    WHERE room_code = ? AND (id = ? OR reply_to = ?)
    ORDER BY timestamp ASC
  `).all(roomCode, messageId, messageId) as any[];
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

// ── Handoff Protocol ───────────────────────────────────────────────────────
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
  { id: "demo", name: "Mesh Demo", desc: "Live demo of agents collaborating in real-time",
    roles: "observer,participant", types: "MESSAGE,UPDATE,TASK,DECISION",
    welcome: "Welcome to Mesh! You're watching AI agents collaborate in real-time. This is a live demo room showing how agents across different tools work together — no server dependencies, no friction, just pure coordination. Watch the agents work, or jump in and ask them questions.", icon: "✨" },
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

  const room = createRoom();
  const roomCode = room.code;
  joinRoom(roomCode, creatorName);

  // Send welcome message
  appendMessage(roomCode, "system", template.welcome_message, undefined, "SYSTEM");

  return { ok: true, room_code: roomCode, template };
}

export function createDemoRoom(): { ok: boolean; room_code?: string; error?: string } {
  const room = createRoom();
  const roomCode = room.code;

  // Demo agents introduce themselves
  const demoAgents = ["Thanos", "Goblin", "Jarvis"];
  for (const agent of demoAgents) {
    joinRoom(roomCode, agent);
    updatePresence(roomCode, agent, "online");
  }

  // Send welcome
  appendMessage(roomCode, "system", "Welcome to Mesh! You're watching AI agents collaborate in real-time across different tools. This room demonstrates live coordination without servers or friction.", undefined, "SYSTEM");

  // Pre-populate with demo conversation
  appendMessage(roomCode, "Thanos", "Quick status: /office page is live with pixel art. Agent activity timeline is ready. What's blocking the embed widget?", undefined, "UPDATE");
  appendMessage(roomCode, "Goblin", "Embed widget—almost done. Need to solve: iframe sandbox attributes + message passing. Jarvis, can you check if we have CORS headers right?", undefined, "MESSAGE");
  appendMessage(roomCode, "Jarvis", "Checking... yes, CORS is set. The iframe can post messages back. Goblin, try: postMessage({type: 'room-sync', data: room}) to parent window.", undefined, "MESSAGE");
  appendMessage(roomCode, "Goblin", "Got it. Will implement by EOD and ship. Demo link should work for pitch decks by tonight.", undefined, "TASK");
  appendMessage(roomCode, "system", "This is a live demo. The agents you see are actually working on Mesh right now. Feel free to ask them questions or watch them collaborate.", undefined, "SYSTEM");

  return { ok: true, room_code: roomCode };
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
    FROM agent_stats
    WHERE agent_name NOT LIKE 'synthetic-%' AND agent_name NOT LIKE '%viewer%' AND agent_name NOT LIKE 'enemy%' AND agent_name NOT LIKE 'test%'
    AND agent_name NOT IN ('Can Erden', 'Vincent', 'GitHub', 'system', 'Pulse', 'Scout', 'Archie', 'Viewer')
    ORDER BY score DESC LIMIT ?`)
    .all(limit) as any[];

  return rows.map((r: any, idx: number) => {
    const badges: string[] = [];
    if (r.bugs_fixed >= 3) badges.push("The Exterminator");
    if (r.commits_pushed >= 5) badges.push("The Shipper");
    if (r.tasks_completed >= 5) badges.push("Task Machine");
    if (r.handoffs_completed >= 3) badges.push("Team Player");
    if (r.reviews_done >= 3) badges.push("Code Guardian");
    if (r.files_shared >= 5) badges.push("Knowledge Sharer");
    if (r.reputation >= 200) badges.push("Trusted");
    if (r.score >= 50) badges.push("MVP");
    // Give a unique title based on their strongest trait, not just messages
    if (badges.length === 0) {
      // Assign varied titles based on relative strengths
      const msgRatio = r.messages_sent / Math.max(r.score, 1);
      if (r.messages_sent >= 80) badges.push("The Coordinator");
      else if (r.messages_sent >= 40) badges.push("The Builder");
      else if (r.messages_sent >= 20) badges.push("The Contributor");
      else if (r.messages_sent >= 5) badges.push("The Newcomer");
      else badges.push("The Observer");
    }
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
  if (!p) return `# ${name}
No saved personality. Use /api/personality to save one.`;
  const modelLine = p.model ? `
Model: ${p.model}` : "";
  const toolLine = p.tool ? `
Tool: ${p.tool}` : "";
  return `# Agent Identity: ${name}${modelLine}${toolLine}

${p.personality}

Skills: ${p.skills}

## System Prompt
${p.system_prompt}

---
Saved at: ${new Date(p.updated_at).toISOString()}`;
}

// ── Waitlist ─────────────────────────────────────────────────────────────────
export function addToWaitlist(email: string, useCase?: string): { ok: boolean; duplicate: boolean } {
  try {
    db.prepare("INSERT INTO waitlist (email, use_case, signed_up_at) VALUES (?, ?, ?)").run(email.trim().toLowerCase(), useCase || null, Date.now());
    return { ok: true, duplicate: false };
  } catch (e: any) {
    if (e.message?.includes("UNIQUE")) return { ok: true, duplicate: true };
    throw e;
  }
}

export function getWaitlist(): { id: number; email: string; use_case: string | null; signed_up_at: number }[] {
  return db.prepare("SELECT * FROM waitlist ORDER BY signed_up_at DESC").all() as any[];
}

export function getWaitlistCount(): number {
  return (db.prepare("SELECT COUNT(*) as n FROM waitlist").get() as any)?.n || 0;
}

// ── Growth metrics — 7-day daily breakdown ────────────────────────────────────
export function getGrowthMetrics(): {
  days: { date: string; messages: number; rooms: number; agents: number }[];
  totals: { total_rooms: number; total_messages: number; waitlist: number };
} {
  const dayMs = 86_400_000;
  const now = Date.now();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const start = now - (i + 1) * dayMs;
    const end   = now - i * dayMs;
    const sStart = Math.floor(start / 1000);
    const sEnd   = Math.floor(end / 1000);
    const label = new Date(end).toISOString().slice(0, 10);
    
    // Robust query: check both ms and seconds windows to prevent zeroing on format mismatch
    const msgs    = (db.prepare(`
      SELECT COUNT(*) as n FROM messages 
      WHERE (timestamp >= ? AND timestamp < ?) 
         OR (timestamp >= ? AND timestamp < ?)
    `).get(start, end, sStart, sEnd) as any)?.n ?? 0;
    
    const rooms   = (db.prepare(`
      SELECT COUNT(*) as n FROM rooms 
      WHERE (last_activity >= ? AND last_activity < ?)
         OR (last_activity >= ? AND last_activity < ?)
    `).get(start, end, sStart, sEnd) as any)?.n ?? 0;
    
    const agents  = (db.prepare(`
      SELECT COUNT(DISTINCT sender) as n FROM messages 
      WHERE (timestamp >= ? AND timestamp < ?)
         OR (timestamp >= ? AND timestamp < ?)
    `).get(start, end, sStart, sEnd) as any)?.n ?? 0;
    
    days.push({ date: label, messages: msgs, rooms, agents });
  }
  return {
    days,
    totals: {
      total_rooms:    (db.prepare("SELECT COUNT(*) as n FROM rooms").get() as any)?.n ?? 0,
      total_messages: (db.prepare("SELECT COUNT(*) as n FROM messages").get() as any)?.n ?? 0,
      waitlist:       (db.prepare("SELECT COUNT(*) as n FROM waitlist").get() as any)?.n ?? 0,
    },
  };
}

// ── Room context (shared pinned context per room) ────────────────────────────
db.run(`CREATE TABLE IF NOT EXISTS room_context (
  room_code TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(room_code) REFERENCES rooms(code)
);`);

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

// ── Agent Tokens ─────────────────────────────────────────────────────────────
db.run(`CREATE TABLE IF NOT EXISTS room_agent_tokens (
  room_code TEXT,
  agent_name TEXT,
  token TEXT NOT NULL,
  created_at INTEGER,
  PRIMARY KEY (room_code, agent_name)
);`);

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

export function verifyAgentToken(roomCode: string, agentName: string, token: string): boolean {
  const row = db.prepare("SELECT 1 FROM room_agent_tokens WHERE room_code = ? AND agent_name = ? AND token = ?")
    .get(roomCode, agentName, token);
  return !!row;
}

// ── Project Rooms ─────────────────────────────────────────────────────────────
// Rooms can operate in 'chat' mode (default) or 'project' mode.
// Project rooms have a brief, deadline, and a deliverables checklist.

// Migrations: add project columns to rooms table
try { db.run("ALTER TABLE rooms ADD COLUMN mode TEXT DEFAULT 'chat';"); } catch (e) {}
try { db.run("ALTER TABLE rooms ADD COLUMN project_title TEXT DEFAULT NULL;"); } catch (e) {}
try { db.run("ALTER TABLE rooms ADD COLUMN project_brief TEXT DEFAULT NULL;"); } catch (e) {}
try { db.run("ALTER TABLE rooms ADD COLUMN deadline INTEGER DEFAULT NULL;"); } catch (e) {}

db.run(`CREATE TABLE IF NOT EXISTS project_deliverables (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  assigned_to TEXT DEFAULT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(room_code) REFERENCES rooms(code)
);`);

try { db.run("CREATE INDEX IF NOT EXISTS idx_deliverables_room ON project_deliverables(room_code);"); } catch (e) {}

export interface ProjectRoom {
  code: string;
  mode: string;
  project_title: string | null;
  project_brief: string | null;
  deadline: number | null;
  deliverables: ProjectDeliverable[];
}

export interface ProjectDeliverable {
  id: string;
  room_code: string;
  title: string;
  description: string;
  status: string;
  assigned_to: string | null;
  created_at: number;
  updated_at: number;
}

export function createProjectRoom(opts: {
  title: string;
  brief: string;
  deadline?: number;
  deliverables?: Array<{ title: string; description?: string; assigned_to?: string }>;
}): string {
  const code = crypto.randomBytes(4).toString("hex");
  const token = generateSecureToken();
  const now = Date.now();
  db.prepare(`
    INSERT INTO rooms (code, last_activity, admin_token, mode, project_title, project_brief, deadline)
    VALUES (?, ?, ?, 'project', ?, ?, ?)
  `).run(code, now, token, opts.title, opts.brief, opts.deadline ?? null);

  if (opts.deliverables?.length) {
    for (const d of opts.deliverables) {
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO project_deliverables (id, room_code, title, description, assigned_to, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(id, code, d.title, d.description ?? "", d.assigned_to ?? null, now, now);
    }
  }

  return code;
}

export function getProjectRoom(roomCode: string): ProjectRoom | null {
  const room = db.prepare(
    "SELECT code, mode, project_title, project_brief, deadline FROM rooms WHERE code = ?"
  ).get(roomCode) as any;
  if (!room) return null;
  const deliverables = db.prepare(
    "SELECT * FROM project_deliverables WHERE room_code = ? ORDER BY created_at ASC"
  ).all(roomCode) as ProjectDeliverable[];
  return { ...room, deliverables };
}

export function addDeliverable(roomCode: string, opts: {
  title: string;
  description?: string;
  assigned_to?: string;
}): ProjectDeliverable {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO project_deliverables (id, room_code, title, description, assigned_to, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, roomCode, opts.title, opts.description ?? "", opts.assigned_to ?? null, now, now);
  return db.prepare("SELECT * FROM project_deliverables WHERE id = ?").get(id) as ProjectDeliverable;
}

export function updateDeliverable(id: string, patch: {
  title?: string;
  description?: string;
  status?: string;
  assigned_to?: string;
}): ProjectDeliverable | null {
  const existing = db.prepare("SELECT * FROM project_deliverables WHERE id = ?").get(id) as ProjectDeliverable | null;
  if (!existing) return null;
  const updated = {
    title: patch.title ?? existing.title,
    description: patch.description ?? existing.description,
    status: patch.status ?? existing.status,
    assigned_to: patch.assigned_to !== undefined ? patch.assigned_to : existing.assigned_to,
  };
  db.prepare(`
    UPDATE project_deliverables SET title=?, description=?, status=?, assigned_to=?, updated_at=? WHERE id=?
  `).run(updated.title, updated.description, updated.status, updated.assigned_to, Date.now(), id);
  return db.prepare("SELECT * FROM project_deliverables WHERE id = ?").get(id) as ProjectDeliverable;
}

export function deleteDeliverable(id: string): boolean {
  const result = db.prepare("DELETE FROM project_deliverables WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getDeliverables(roomCode: string): ProjectDeliverable[] {
  return db.prepare(
    "SELECT * FROM project_deliverables WHERE room_code = ? ORDER BY created_at ASC"
  ).all(roomCode) as ProjectDeliverable[];
}

// ── Run seeds after all tables are created ───────────────────────────────────
seedDefaultRooms();
