import type { Hono } from "hono";
import {
  createQueueTask,
  claimQueueTask,
  releaseQueueTask,
  updateQueueTask,
  getOpenQueueTasks,
  getQueueTasks,
  ensureRoom,
  joinRoom,
} from "../rooms.js";

export function registerQueueRoutes(app: Hono) {
  // Create a task in the queue
  app.post("/api/queue/tasks", async (c) => {
    const room = c.req.query("room");
    const name = c.req.query("name");
    if (!room || !name) return c.json({ error: "missing room or name" }, 400);
    ensureRoom(room);
    joinRoom(room, name);

    const { task_id, title, description, priority } = await c.req.json();
    if (!task_id || !title) return c.json({ error: "missing task_id or title" }, 400);

    try {
      const task = createQueueTask(room, task_id, title, description || "", name, priority || 0);
      return c.json({ ok: true, task });
    } catch (e: any) {
      if (e.message?.includes("UNIQUE constraint")) {
        return c.json({ error: "task_id_exists", detail: `Task ${task_id} already exists in this room` }, 409);
      }
      return c.json({ error: "create_failed", detail: e.message }, 500);
    }
  });

  // List tasks (optional status filter)
  app.get("/api/queue/tasks", (c) => {
    const room = c.req.query("room");
    if (!room) return c.json({ error: "missing room" }, 400);

    const status = c.req.query("status");
    const tasks = status ? getQueueTasks(room, status) : getQueueTasks(room);
    return c.json({ ok: true, tasks, count: tasks.length });
  });

  // Claim a task (atomic — 409 if already claimed)
  app.post("/api/queue/claim", async (c) => {
    const room = c.req.query("room");
    const name = c.req.query("name");
    if (!room || !name) return c.json({ error: "missing room or name" }, 400);

    const { task_id } = await c.req.json();
    if (!task_id) return c.json({ error: "missing task_id" }, 400);

    const result = claimQueueTask(room, task_id, name);
    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, 409);
    }
    return c.json({ ok: true, task_id, claimed_by: name });
  });

  // Release a claimed task
  app.post("/api/queue/release", async (c) => {
    const room = c.req.query("room");
    const name = c.req.query("name");
    if (!room || !name) return c.json({ error: "missing room or name" }, 400);

    const { task_id } = await c.req.json();
    if (!task_id) return c.json({ error: "missing task_id" }, 400);

    const result = releaseQueueTask(room, task_id, name);
    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, 403);
    }
    return c.json({ ok: true, task_id, released: true });
  });

  // Update a task (status, branch, PR, metadata)
  app.put("/api/queue/tasks/:task_id", async (c) => {
    const room = c.req.query("room");
    const name = c.req.query("name");
    const task_id = c.req.param("task_id");
    if (!room || !name) return c.json({ error: "missing room or name" }, 400);

    const updates = await c.req.json();
    const result = updateQueueTask(room, task_id, name, updates);
    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, 403);
    }
    return c.json({ ok: true, task_id, updated: true });
  });
}
