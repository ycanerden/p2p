import { test, expect, beforeEach } from "bun:test";
import {
  createRoom,
  joinRoom,
  appendMessage,
  getMessages,
  getRoomStatus,
  sweepExpiredRooms,
  getRoomCount,
  publishCard,
} from "./rooms.js";

// Reset module state between tests by re-importing fresh — not possible with
// static imports, so we rely on unique room codes per test instead.

test("createRoom returns a 6-char code", () => {
  const code = createRoom();
  expect(code).toHaveLength(6);
  expect(code).toMatch(/^[a-z0-9]{6}$/);
});

test("createRoom codes are unique across calls", () => {
  const codes = new Set(Array.from({ length: 20 }, () => createRoom()));
  expect(codes.size).toBe(20);
});

test("joinRoom returns null for unknown room", () => {
  expect(joinRoom("zzzzzz", "alice")).toBeNull();
});

test("joinRoom creates user state on first join", () => {
  const code = createRoom();
  const room = joinRoom(code, "alice");
  expect(room).not.toBeNull();
});

test("appendMessage: happy path", () => {
  const code = createRoom();
  joinRoom(code, "alice");
  const result = appendMessage(code, "alice", "hello");
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.id).toHaveLength(36); // UUID
});

test("appendMessage: rejects messages over 10KB", () => {
  const code = createRoom();
  const big = "x".repeat(10 * 1024 + 1);
  const result = appendMessage(code, "alice", big);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBe("message_too_large");
});

test("appendMessage: unknown room returns room_expired error", () => {
  const result = appendMessage("xxxxxx", "alice", "hi");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBe("room_expired_or_not_found");
});

test("getMessages: returns partner messages after cursor, not own", () => {
  const code = createRoom();
  joinRoom(code, "alice");
  joinRoom(code, "bob");

  appendMessage(code, "alice", "msg from alice");
  appendMessage(code, "bob", "msg from bob");

  const result = getMessages(code, "bob"); // bob reads — should only see alice's
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].from).toBe("alice");
    expect(result.messages[0].content).toBe("msg from alice");
  }
});

test("getMessages: cursor advances — second call returns empty", () => {
  const code = createRoom();
  joinRoom(code, "alice");
  joinRoom(code, "bob");
  appendMessage(code, "alice", "hi");

  getMessages(code, "bob"); // first read
  const second = getMessages(code, "bob"); // second read
  expect(second.ok).toBe(true);
  if (second.ok) expect(second.messages).toHaveLength(0);
});

test("getMessages: empty room returns []", () => {
  const code = createRoom();
  joinRoom(code, "alice");
  const result = getMessages(code, "alice");
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.messages).toHaveLength(0);
});

test("getMessages: unknown room returns room_expired error", () => {
  const result = getMessages("xxxxxx", "alice");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBe("room_expired_or_not_found");
});

test("getMessages: returns messages in timestamp order", () => {
  const code = createRoom();
  joinRoom(code, "alice");
  joinRoom(code, "bob");

  appendMessage(code, "alice", "first");
  appendMessage(code, "alice", "second");
  appendMessage(code, "alice", "third");

  const result = getMessages(code, "bob");
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.messages.map((m) => m.content)).toEqual([
      "first",
      "second",
      "third",
    ]);
  }
});

test("getRoomStatus: solo user shows not connected", () => {
  const code = createRoom();
  joinRoom(code, "alice");
  const result = getRoomStatus(code, "alice");
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.connected).toBe(false);
    expect(result.partners).toHaveLength(0);
  }
});

test("getRoomStatus: two users shows connected with partner", () => {
  const code = createRoom();
  joinRoom(code, "alice");
  joinRoom(code, "bob");
  const result = getRoomStatus(code, "alice");
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.connected).toBe(true);
    expect(result.partners[0].name).toBe("bob");
    expect(result.partners.find(p => p.name === "alice")).toBeUndefined();
  }
});

test("getRoomStatus: unknown room returns room_expired error", () => {
  const result = getRoomStatus("xxxxxx", "alice");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBe("room_expired_or_not_found");
});

test("getRoomStatus: includes message_count", () => {
  const code = createRoom();
  joinRoom(code, "alice");
  appendMessage(code, "alice", "a");
  appendMessage(code, "alice", "b");
  const result = getRoomStatus(code, "alice");
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.message_count).toBe(2);
});

test("publishCard: stores and broadcasts agent card", () => {
  const code = createRoom();
  joinRoom(code, "alice");
  joinRoom(code, "bob");
  
  const card = { agent: { name: "Batman", model: "gemini-2.0-flash", tool: "gemini-cli" }, skills: ["investigation"] };
  const result = publishCard(code, "alice", card);
  expect(result.ok).toBe(true);
  
  const status = getRoomStatus(code, "bob");
  expect(status.ok).toBe(true);
  if (status.ok) {
    expect(status.partners).toHaveLength(1);
    expect(status.partners[0].name).toBe("alice");
    expect(status.partners[0].card).toEqual(card);
  }
});

test("publishCard: system message is posted on card update", () => {
  const code = createRoom();
  joinRoom(code, "alice");
  joinRoom(code, "bob");
  
  const card = { agent: { name: "Batman", model: "gemini-2.0-flash" } };
  publishCard(code, "alice", card);
  
  const msgs = getMessages(code, "bob");
  expect(msgs.ok).toBe(true);
  if (msgs.ok) {
    // Should have 1 message (system)
    expect(msgs.messages).toHaveLength(1);
    expect(msgs.messages[0].from).toBe("system");
    expect(msgs.messages[0].content).toContain("Batman (gemini-2.0-flash) updated their Agent Card");
  }
});

test("sweepExpiredRooms: does not delete active rooms", () => {
  const before = getRoomCount();
  createRoom();
  const after = getRoomCount();
  sweepExpiredRooms(); // nothing is expired
  expect(getRoomCount()).toBe(after);
});
