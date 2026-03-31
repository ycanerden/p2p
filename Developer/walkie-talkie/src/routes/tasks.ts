import { Hono } from "hono";
import { createRoom, getRoomCount } from "../rooms.js";
import {
  createRoomGroup, getRoomGroup, getAllRoomGroups,
  assignTask, updateTaskStatus, getAgentTasks, getRoomTasks, getAllAgentTasks,
} from "../room-manager.js";
import { startTime } from "./api.js";

const tasks = new Hono();

// ── Task Board API ─────────────────────────────────────────────────────────

tasks.get("/api/tasks", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  const taskList = getRoomTasks(room);
  const grouped = {
    pending: taskList.filter(t => t.status === "pending"),
    in_progress: taskList.filter(t => t.status === "in_progress"),
    blocked: taskList.filter(t => t.status === "blocked"),
    done: taskList.filter(t => t.status === "done"),
  };
  return c.json({ ok: true, tasks: taskList, grouped, total: taskList.length });
});

tasks.post("/api/tasks", async (c) => {
  const { room_code, agent_name, task_id, task_title, due_date } = await c.req.json();
  if (!room_code || !agent_name || !task_id || !task_title) {
    return c.json({ error: "missing required fields" }, 400);
  }
  const task = assignTask(room_code, agent_name, task_id, task_title, due_date || Date.now() + 24 * 60 * 60 * 1000);
  return c.json({ ok: true, task });
});

tasks.put("/api/tasks/:taskId/status", async (c) => {
  const { room_code, agent_name, status } = await c.req.json();
  const taskId = c.req.param("taskId");
  if (!room_code || !agent_name || !status) return c.json({ error: "missing required fields" }, 400);
  updateTaskStatus(room_code, agent_name, taskId, status);
  return c.json({ ok: true, task_id: taskId, new_status: status });
});

// ── Room Groups ────────────────────────────────────────────────────────────

tasks.get("/groups", (c) => {
  return c.json({ groups: getAllRoomGroups(), count: getAllRoomGroups().length });
});

tasks.post("/groups/create", async (c) => {
  const { group_name, description, topic, icon, color } = await c.req.json();
  const creator = c.req.query("creator") || "unknown";
  const roomCode = createRoom();
  const group = createRoomGroup(roomCode, group_name, description, topic, creator as string, icon || "🚀", color || "#4fc3f7");
  return c.json(group, 201);
});

tasks.get("/groups/:roomCode", (c) => {
  const roomCode = c.req.param("roomCode");
  const group = getRoomGroup(roomCode);
  if (!group) return c.json({ error: "group not found" }, 404);
  return c.json({ group, tasks: getRoomTasks(roomCode) });
});

// ── Task Assignments ───────────────────────────────────────────────────────

tasks.post("/tasks/assign", async (c) => {
  const { room_code, agent_name, task_id, task_title, due_date } = await c.req.json();
  const task = assignTask(room_code, agent_name, task_id, task_title, due_date || Date.now() + 24 * 60 * 60 * 1000);
  return c.json(task, 201);
});

tasks.put("/tasks/status", async (c) => {
  const { room_code, agent_name, task_id, status } = await c.req.json();
  updateTaskStatus(room_code, agent_name, task_id, status);
  return c.json({ ok: true, status });
});

tasks.get("/tasks/agent/:agentName", (c) => {
  const agentName = c.req.param("agentName");
  const taskList = getAllAgentTasks(agentName);
  return c.json({ agent: agentName, tasks: taskList, count: taskList.length });
});

tasks.get("/tasks/room/:roomCode", (c) => {
  const roomCode = c.req.param("roomCode");
  const taskList = getRoomTasks(roomCode);
  return c.json({ room: roomCode, tasks: taskList, count: taskList.length });
});

// ── Dashboard Data ─────────────────────────────────────────────────────────

tasks.get("/api/dashboard-data", (c) => {
  const groups = getAllRoomGroups();
  const roomData = groups.map((group) => ({
    ...group, tasks: getRoomTasks(group.room_code),
  }));
  return c.json({
    groups: roomData, total_groups: groups.length,
    active_rooms: getRoomCount(), server_time: Date.now(),
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
  });
});

export default tasks;
