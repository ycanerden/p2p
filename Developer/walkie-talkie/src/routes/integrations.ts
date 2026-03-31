import { Hono } from "hono";
import {
  appendMessage, verifyAdmin, setTelegramConfig, getTelegramConfig,
  trackAgentActivity, getAdminToken,
} from "../rooms.js";
import { createDecision, getDecision, getPendingDecisions, resolveDecision } from "../room-manager.js";

const integrations = new Hono();

// ── Telegram helpers ───────────────────────────────────────────────────────

async function telegramApiCall(token: string, method: string, body: any, maxRetries = 3): Promise<{ ok: boolean; result?: any; error?: string }> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json() as any;
      if (d.ok) return { ok: true, result: d.result };
      if (res.status === 429 && d.parameters?.retry_after) {
        await new Promise(r => setTimeout(r, d.parameters.retry_after * 1000));
        continue;
      }
      console.error(`[telegram] API error (${method}):`, d.description);
      if (i === maxRetries - 1) return { ok: false, error: d.description };
    } catch (e: any) {
      console.error(`[telegram] Network error (${method}):`, e.message);
      if (i === maxRetries - 1) return { ok: false, error: e.message };
    }
    await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
  }
  return { ok: false, error: "max_retries_exceeded" };
}

function tgEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendTelegramMessage(roomCode: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const { token, chatId } = getTelegramConfig(roomCode);
  if (!token || !chatId) return { ok: false, error: "not_configured" };
  const res = await telegramApiCall(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
  return { ok: res.ok, error: res.error };
}

const telegramSendLog = new Map<string, number[]>();
function canSendTelegram(roomCode: string): boolean {
  const now = Date.now();
  const log = telegramSendLog.get(roomCode) || [];
  const recent = log.filter(t => now - t < 60 * 60 * 1000);
  telegramSendLog.set(roomCode, recent);
  if (recent.length >= 10) return false;
  recent.push(now);
  return true;
}

// ── Decisions ──────────────────────────────────────────────────────────────

integrations.post("/api/decisions", async (c) => {
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!room || !name) return c.json({ error: "missing room or name" }, 400);
  try {
    const { description, notifyList } = await c.req.json();
    if (!description || !notifyList || !Array.isArray(notifyList)) {
      return c.json({ error: "missing description or notifyList" }, 400);
    }
    const decision = createDecision(room, name, description, notifyList);
    const mentions = notifyList.map(u => `@${u}`).join(" ");
    appendMessage(room, name, `🚨 DECISION REQUIRED: ${description}\n\nNotified: ${mentions}\nID: ${decision.id}`, null, "DECISION");
    if (canSendTelegram(room)) {
      await sendTelegramMessage(room, `🚨 <b>DECISION NEEDED</b> — ${tgEscape(room)}\n\n${tgEscape(description)}\n\nReply with:\n/approve ${decision.id}\n/reject ${decision.id}\n/hold ${decision.id}`);
    }
    return c.json({ ok: true, decision });
  } catch (e) {
    return c.json({ error: "invalid_request", detail: String(e) }, 400);
  }
});

const telegramTestHandler = async (c: any) => {
  const code = c.req.param("code");
  const token = c.req.header("x-mesh-secret") || c.req.query("token") || (await c.req.json().catch(() => ({} as any))).secret;
  if (!verifyAdmin(code, token)) return c.json({ ok: false, error: "unauthorized" }, 401);
  const result = await sendTelegramMessage(code, `✅ Mesh test ping — room <b>${code}</b> is connected.`);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
  return c.json({ ok: true, message: "Test ping sent! Check your Telegram." });
};
integrations.get("/api/rooms/:code/telegram/test", telegramTestHandler);
integrations.post("/api/rooms/:code/telegram/test", telegramTestHandler);

integrations.get("/api/decisions", (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  return c.json({ ok: true, decisions: getPendingDecisions(room) });
});

integrations.post("/api/decisions/:id", async (c) => {
  const id = c.req.param("id");
  const room = c.req.query("room");
  const name = c.req.query("name");
  if (!id || !room || !name) return c.json({ error: "missing id, room, or name" }, 400);
  const decision = getDecision(id);
  if (!decision) return c.json({ error: "decision not found" }, 404);
  if (decision.status !== "pending") return c.json({ error: "decision already resolved" }, 409);
  try {
    const { status, text } = await c.req.json();
    if (!["approved", "rejected", "hold"].includes(status)) return c.json({ error: "invalid status" }, 400);
    resolveDecision(id, status, text || "", name);
    const emoji = { approved: "✅", rejected: "❌", hold: "⏸️" }[status];
    appendMessage(room, name, `${emoji} DECISION RESOLVED:\n${decision.description}\n**${status.toUpperCase()}** by @${name}${text ? `: ${text}` : ""}`, null, "RESOLUTION");
    return c.json({ ok: true, decision: getDecision(id) });
  } catch (e) {
    return c.json({ error: "invalid_request", detail: String(e) }, 400);
  }
});

// ── Telegram config ────────────────────────────────────────────────────────

integrations.post("/api/rooms/:code/telegram", async (c) => {
  const code = c.req.param("code");
  const token = c.req.header("x-mesh-secret") || c.req.query("secret");
  if (!verifyAdmin(code, token)) return c.json({ ok: false, error: "unauthorized" }, 401);
  const { telegram_token, telegram_chat_id } = await c.req.json();
  if (!telegram_token || !telegram_chat_id) return c.json({ ok: false, error: "missing_fields" }, 400);
  setTelegramConfig(code, telegram_token, telegram_chat_id);
  const baseUrl = process.env.PUBLIC_URL || c.req.url.split("/api")[0];
  const webhookUrl = `${baseUrl}/api/webhook/telegram/${code}`;
  const webhookSecret = (token || "mesh").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  try {
    await fetch(`https://api.telegram.org/bot${telegram_token}/setWebhook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl, secret_token: webhookSecret }),
    });
  } catch (e) { console.error("[telegram] Failed to set webhook:", e); }
  return c.json({ ok: true, webhook_url: webhookUrl });
});

integrations.get("/api/rooms/:code/telegram/status", async (c) => {
  const code = c.req.param("code");
  const token = c.req.header("x-mesh-secret") || c.req.query("token");
  if (!verifyAdmin(code, token)) return c.json({ ok: false, error: "unauthorized" }, 401);
  const { token: botToken, chatId } = getTelegramConfig(code);
  return c.json({ ok: true, connected: !!(botToken && chatId), has_token: !!botToken, has_chat_id: !!chatId });
});

integrations.post("/api/webhook/telegram/:code", async (c) => {
  const code = c.req.param("code");
  const secret = c.req.header("x-telegram-bot-api-secret-token");
  const roomAdminToken = getAdminToken(code);
  const expectedSecret = (roomAdminToken || "mesh").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  if (secret !== expectedSecret) {
    console.warn(`[telegram] Webhook rejected: invalid secret token for room ${code}`);
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  const body = await c.req.json();
  if (body.message && body.message.text) {
    const msg = body.message;
    const from = msg.from?.first_name || msg.from?.username || "Unknown";
    const text = msg.text.trim();
    const { chatId: configuredChatId } = getTelegramConfig(code);
    if (configuredChatId && String(msg.chat?.id) !== String(configuredChatId)) {
      return c.json({ ok: true });
    }
    const cmdMatch = text.match(/^\/(approve|reject|hold)\s+(\S+)/i);
    if (cmdMatch) {
      const [, action, decisionId] = cmdMatch;
      const statusMap: Record<string, "approved" | "rejected" | "hold"> = { approve: "approved", reject: "rejected", hold: "hold" };
      const status = statusMap[action.toLowerCase()];
      if (!status) return c.json({ ok: true });
      const decision = getDecision(decisionId);
      if (decision && decision.status === "pending") {
        resolveDecision(decisionId, status, `Via Telegram by ${from}`, from);
        const emoji = { approved: "✅", rejected: "❌", hold: "⏸️" }[status];
        appendMessage(code, `${from} (Telegram)`, `${emoji} DECISION ${status.toUpperCase()} by ${from} (via Telegram):\n${decision.description}`, undefined, "RESOLUTION");
        await sendTelegramMessage(code, `${emoji} Got it — decision <b>${tgEscape(status)}</b>.\n${tgEscape(decision.description)}`);
      } else {
        await sendTelegramMessage(code, `⚠️ Decision <code>${tgEscape(decisionId)}</code> not found or already resolved.`);
      }
      return c.json({ ok: true });
    }
    appendMessage(code, `${from} (Telegram)`, text, undefined, "BROADCAST");
    const baseUrl = process.env.PUBLIC_URL || "https://trymesh.chat";
    await sendTelegramMessage(code, `✓ Posted to #${code}. View replies: ${baseUrl}/dashboard?room=${code}`);
  }
  return c.json({ ok: true });
});

// ── GitHub Webhook ─────────────────────────────────────────────────────────

integrations.post("/api/webhooks/github", async (c) => {
  const room = c.req.query("room");
  if (!room) return c.json({ error: "missing room" }, 400);
  const event = c.req.header("x-github-event");
  try {
    const payload = await c.req.json();
    let message = "";
    if (event === "push") {
      const repo = payload.repository.full_name;
      const branch = payload.ref.split("/").pop();
      const commits = payload.commits || [];
      if (commits.length === 0) return c.json({ ok: true });
      message = `📦 **Push to ${repo} (${branch})**\n`;
      commits.slice(0, 3).forEach((commit: any) => { message += `• ${commit.message.split("\n")[0]} — ${commit.author.name}\n`; });
      if (commits.length > 3) message += `• ...and ${commits.length - 3} more commits`;
      const authorCounts = new Map<string, number>();
      for (const commit of commits) {
        const author = commit.author?.name;
        if (author) authorCounts.set(author, (authorCounts.get(author) || 0) + 1);
      }
      for (const [author, count] of authorCounts) { trackAgentActivity(author, "commit", count); }
    } else if (event === "pull_request") {
      message = `🔀 **PR ${payload.action}: ${payload.pull_request.title}**\n${payload.pull_request.html_url}`;
    } else if (event === "issues") {
      message = `🎫 **Issue ${payload.action}: ${payload.issue.title}**\n${payload.issue.html_url}`;
    } else if (event === "ping") {
      message = "📡 GitHub Webhook connected successfully!";
    }
    if (message) appendMessage(room, "GitHub", message, undefined, "BROADCAST");
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "invalid payload" }, 400);
  }
});

export default integrations;
