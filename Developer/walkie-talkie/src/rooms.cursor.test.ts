import { test, expect } from "bun:test";
import { createRoom, joinRoom, appendMessage, getMessages } from "./rooms.js";

test("newly joined user starts at room tail and does not replay history", () => {
  const { code } = createRoom();

  joinRoom(code, "Alice");
  const oldWrite = appendMessage(code, "Alice", "old context");
  expect(oldWrite.ok).toBe(true);

  joinRoom(code, "Bob");
  const firstRead = getMessages(code, "Bob");
  expect(firstRead.ok).toBe(true);
  if (firstRead.ok) {
    expect(firstRead.messages).toHaveLength(0);
  }

  const newWrite = appendMessage(code, "Alice", "new context");
  expect(newWrite.ok).toBe(true);

  const secondRead = getMessages(code, "Bob");
  expect(secondRead.ok).toBe(true);
  if (secondRead.ok) {
    expect(secondRead.messages).toHaveLength(1);
    const msg = secondRead.messages[0];
    expect(msg).toBeTruthy();
    if (msg) expect(msg.content).toBe("new context");
  }
});

test("case-variant rejoin inherits cursor and avoids full replay", () => {
  const { code } = createRoom();

  joinRoom(code, "Tony");
  appendMessage(code, "Alice", "seed");
  getMessages(code, "Tony"); // advance Tony cursor to tail

  joinRoom(code, "tony");
  const read = getMessages(code, "tony");
  expect(read.ok).toBe(true);
  if (read.ok) {
    expect(read.messages).toHaveLength(0);
  }
});
