import { EventEmitter } from "events";

// ── Mesh Event Type Hierarchy ─────────────────────────────────────────────
// Dot-notation event types for structured real-time communication.
// Inspired by best practices but our own design — typed, hierarchical, filterable.
//
// Pattern: mesh.<domain>.<action>
// Wildcards: mesh.message.* matches all message events
//
// This is what OpenAgents does well but we do BETTER:
// - Typed payloads (not untyped dicts)
// - SSE + WebSocket push (they use HTTP polling)
// - Server-side dedup (they rely on client-side)

export type MeshEventType =
  // Messages
  | "mesh.message.sent"
  | "mesh.message.received"
  | "mesh.message.deleted"
  | "mesh.message.reacted"
  // Agents
  | "mesh.agent.joined"
  | "mesh.agent.left"
  | "mesh.agent.typing"
  | "mesh.agent.heartbeat"
  // Rooms
  | "mesh.room.created"
  | "mesh.room.expired"
  // Tasks
  | "mesh.task.assigned"
  | "mesh.task.updated"
  | "mesh.task.completed"
  // Handoffs
  | "mesh.handoff.created"
  | "mesh.handoff.accepted"
  // Files
  | "mesh.file.shared"
  // Decisions
  | "mesh.decision.proposed"
  | "mesh.decision.resolved"
  // System
  | "mesh.system.health"
  | "mesh.system.error";

export interface MeshEvent {
  id: string;
  type: MeshEventType;
  room: string;
  source: string; // agent name or "system"
  target?: string; // optional recipient
  payload: Record<string, any>;
  ts: number;
}

// ── Global event bus ──────────────────────────────────────────────────────
export const meshEvents = new EventEmitter();
meshEvents.setMaxListeners(500);

// ── Emit a typed event ────────────────────────────────────────────────────
export function emitMeshEvent(
  type: MeshEventType,
  room: string,
  source: string,
  payload: Record<string, any>,
  target?: string,
): MeshEvent {
  const event: MeshEvent = {
    id: crypto.randomUUID(),
    type,
    room,
    source,
    target,
    payload,
    ts: Date.now(),
  };

  // Emit on specific type
  meshEvents.emit(type, event);

  // Emit on domain wildcard (e.g., "mesh.message.*" handlers)
  const domain = type.split(".").slice(0, 2).join(".");
  meshEvents.emit(`${domain}.*`, event);

  // Emit on global wildcard
  meshEvents.emit("mesh.*", event);

  return event;
}

// ── Subscribe with pattern matching ───────────────────────────────────────
export function onMeshEvent(
  pattern: string, // e.g., "mesh.message.*" or "mesh.agent.joined"
  handler: (event: MeshEvent) => void,
): () => void {
  meshEvents.on(pattern, handler);
  return () => meshEvents.off(pattern, handler);
}

// ── Event dedup (server-side, unlike OpenAgents' client-side dedup) ───────
const recentEventIds = new Set<string>();
const DEDUP_MAX = 5000;
const DEDUP_TTL = 60_000;

export function isDuplicateEvent(eventId: string): boolean {
  if (recentEventIds.has(eventId)) return true;
  recentEventIds.add(eventId);
  // Cleanup when set gets too large
  if (recentEventIds.size > DEDUP_MAX) {
    const excess = recentEventIds.size - DEDUP_MAX;
    const iter = recentEventIds.values();
    for (let i = 0; i < excess; i++) {
      recentEventIds.delete(iter.next().value!);
    }
  }
  return false;
}
