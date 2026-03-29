// Room Manager - WhatsApp-like group system for AI agents
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";

// Use same DB path as rooms.ts — /app/data/ on Railway, local otherwise
const DB_DIR = process.env.NODE_ENV === "production" ? "/app/data" : ".";
if (DB_DIR !== "." && !existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
const db = new Database(`${DB_DIR}/mesh.db`, { create: true });

// Initialize rooms metadata table
db.run(`
  CREATE TABLE IF NOT EXISTS room_groups (
    room_code TEXT PRIMARY KEY,
    group_name TEXT,
    description TEXT,
    topic TEXT,
    created_at INTEGER,
    creator TEXT,
    is_public BOOLEAN DEFAULT 1,
    icon TEXT,
    color TEXT
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS room_assignments (
    room_code TEXT,
    agent_name TEXT,
    task_id TEXT,
    task_title TEXT,
    status TEXT,
    assigned_at INTEGER,
    due_date INTEGER,
    PRIMARY KEY(room_code, agent_name, task_id)
  );
`);

// Auto-seed default tasks for mesh01 if empty
(function autoSeedTasks() {
  const count = db.prepare("SELECT COUNT(*) as n FROM room_assignments WHERE room_code = 'mesh01'").get() as any;
  if (count.n === 0) {
    const now = Date.now();
    const tasks = [
      ["mesh01", "Lisan", "task-landing-signoff", "Finalize landing page copy & sign-off", "in_progress"],
      ["mesh01", "Can", "task-telegram-ping", "Run Telegram Test Ping", "pending"],
      ["mesh01", "Goblin", "task-validation", "Final validation pass & bug hunt", "in_progress"],
      ["mesh01", "Jarvis", "task-dedup-fix", "Monitor Jarvis message dedup", "done"]
    ];
    for (const t of tasks) {
      db.prepare(`INSERT INTO room_assignments (room_code, agent_name, task_id, task_title, status, assigned_at) 
                 VALUES (?, ?, ?, ?, ?, ?)`).run(t[0]!, t[1]!, t[2]!, t[3]!, t[4]!, now);
    }
    console.log("[seed] Seeded mesh01 task board");
  }
})();

export interface RoomGroup {
  room_code: string;
  group_name: string;
  description: string;
  topic: string;
  created_at: number;
  creator: string;
  is_public: boolean;
  icon: string;
  color: string;
}

export interface TaskAssignment {
  room_code: string;
  agent_name: string;
  task_id: string;
  task_title: string;
  status: "pending" | "in_progress" | "blocked" | "done";
  assigned_at: number;
  due_date: number;
}

export function createRoomGroup(
  roomCode: string,
  groupName: string,
  description: string,
  topic: string,
  creator: string,
  icon: string = "🚀",
  color: string = "#4fc3f7"
): RoomGroup {
  const group: RoomGroup = {
    room_code: roomCode,
    group_name: groupName,
    description,
    topic,
    created_at: Date.now(),
    creator,
    is_public: true,
    icon,
    color,
  };

  db.prepare(
    `INSERT INTO room_groups (room_code, group_name, description, topic, created_at, creator, is_public, icon, color)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    roomCode,
    groupName,
    description,
    topic,
    group.created_at,
    creator,
    group.is_public,
    icon,
    color
  );

  return group;
}

export function getRoomGroup(roomCode: string): RoomGroup | null {
  const result = db
    .prepare("SELECT * FROM room_groups WHERE room_code = ?")
    .get(roomCode) as any;
  return result || null;
}

export function getAllRoomGroups(): RoomGroup[] {
  return db
    .prepare("SELECT * FROM room_groups WHERE is_public = 1 ORDER BY created_at DESC")
    .all() as RoomGroup[];
}

export function assignTask(
  roomCode: string,
  agentName: string,
  taskId: string,
  taskTitle: string,
  dueDate: number
): TaskAssignment {
  const assignment: TaskAssignment = {
    room_code: roomCode,
    agent_name: agentName,
    task_id: taskId,
    task_title: taskTitle,
    status: "pending",
    assigned_at: Date.now(),
    due_date: dueDate,
  };

  db.prepare(
    `INSERT OR REPLACE INTO room_assignments
     (room_code, agent_name, task_id, task_title, status, assigned_at, due_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    roomCode,
    agentName,
    taskId,
    taskTitle,
    "pending",
    assignment.assigned_at,
    dueDate
  );

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

export function getAgentTasks(
  roomCode: string,
  agentName: string
): TaskAssignment[] {
  return db
    .prepare(
      `SELECT * FROM room_assignments WHERE room_code = ? AND agent_name = ? ORDER BY assigned_at`
    )
    .all(roomCode, agentName) as TaskAssignment[];
}

export function getRoomTasks(roomCode: string): TaskAssignment[] {
  return db
    .prepare(`SELECT * FROM room_assignments WHERE room_code = ? ORDER BY assigned_at`)
    .all(roomCode) as TaskAssignment[];
}

export function getAllAgentTasks(agentName: string): TaskAssignment[] {
  return db
    .prepare(
      `SELECT * FROM room_assignments WHERE agent_name = ? ORDER BY assigned_at`
    )
    .all(agentName) as TaskAssignment[];
}

// Decisions table for Telegram Decision Bot
db.run(`
  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    room_code TEXT,
    created_by TEXT,
    description TEXT,
    notified_users TEXT,
    status TEXT DEFAULT 'pending',
    decision_text TEXT,
    decision_by TEXT,
    created_at INTEGER,
    resolved_at INTEGER
  );
`);

export interface Decision {
  id: string;
  room_code: string;
  created_by: string;
  description: string;
  notified_users: string;
  status: "pending" | "approved" | "rejected" | "hold";
  decision_text: string | null;
  decision_by: string | null;
  created_at: number;
  resolved_at: number | null;
}

export function createDecision(
  roomCode: string,
  createdBy: string,
  description: string,
  notifiedUsers: string[]
): Decision {
  const id = `decision-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const decision: Decision = {
    id,
    room_code: roomCode,
    created_by: createdBy,
    description,
    notified_users: notifiedUsers.join(","),
    status: "pending",
    decision_text: null,
    decision_by: null,
    created_at: Date.now(),
    resolved_at: null,
  };

  db.prepare(
    `INSERT INTO decisions (id, room_code, created_by, description, notified_users, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, roomCode, createdBy, description, notifiedUsers.join(","), "pending", decision.created_at);

  return decision;
}

export function getDecision(id: string): Decision | null {
  const result = db
    .prepare("SELECT * FROM decisions WHERE id = ?")
    .get(id) as any;
  return result || null;
}

export function getPendingDecisions(roomCode: string): Decision[] {
  return db
    .prepare(
      `SELECT * FROM decisions WHERE room_code = ? AND status = 'pending' ORDER BY created_at DESC`
    )
    .all(roomCode) as Decision[];
}

export function resolveDecision(
  id: string,
  status: "approved" | "rejected" | "hold",
  decisionText: string,
  decisionBy: string
): void {
  db.prepare(
    `UPDATE decisions SET status = ?, decision_text = ?, decision_by = ?, resolved_at = ? WHERE id = ?`
  ).run(status, decisionText, decisionBy, Date.now(), id);
}
