import { promises as fs } from "node:fs";
import path from "node:path";

const VAULT_PATH = (process.env.OBSIDIAN_VAULT_PATH || "").trim();

function isEnabled(): boolean {
  return VAULT_PATH.length > 0;
}

function safeJoin(relPath: string): string {
  const base = path.resolve(VAULT_PATH);
  const target = path.resolve(base, relPath);
  if (!target.startsWith(base)) {
    throw new Error("invalid_path");
  }
  return target;
}

async function ensureDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

async function appendFile(relPath: string, content: string): Promise<void> {
  const filePath = safeJoin(relPath);
  await ensureDir(filePath);
  await fs.appendFile(filePath, content, "utf-8");
}

async function writeFileAtomic(relPath: string, content: string): Promise<void> {
  const filePath = safeJoin(relPath);
  await ensureDir(filePath);
  const tmpPath = `${filePath}.tmp-${Date.now()}`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function dateStamp(ts: number = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function timeStamp(ts: number = Date.now()): string {
  return new Date(ts).toISOString();
}

export type MemoryResult = { ok: boolean; error?: string };

export async function appendDecision(
  roomCode: string,
  by: string,
  summary: string,
  rationale: string,
  tags: string[] = []
): Promise<MemoryResult> {
  if (!isEnabled()) return { ok: false, error: "obsidian_disabled" };
  if (!summary.trim()) return { ok: false, error: "missing_summary" };

  const fileName = `${dateStamp()}-${slugify(summary) || "decision"}.md`;
  const relPath = path.join("decisions", fileName);
  const body = [
    `# Decision: ${summary}`,
    `Date: ${timeStamp()}`,
    `Room: ${roomCode}`,
    `By: ${by}`,
    tags.length ? `Tags: ${tags.join(", ")}` : "",
    "",
    "## Rationale",
    rationale || "(none)",
    "",
  ].filter(Boolean).join("\n");

  await appendFile(relPath, `${body}\n`);
  return { ok: true };
}

export async function appendShip(
  roomCode: string,
  by: string,
  title: string,
  filesChanged: string[] = [],
  notes?: string
): Promise<MemoryResult> {
  if (!isEnabled()) return { ok: false, error: "obsidian_disabled" };
  if (!title.trim()) return { ok: false, error: "missing_title" };

  const fileName = `${dateStamp()}-${slugify(title) || "ship"}.md`;
  const relPath = path.join("ships", fileName);
  const body = [
    `# Ship: ${title}`,
    `Date: ${timeStamp()}`,
    `Room: ${roomCode}`,
    `By: ${by}`,
    "",
    filesChanged.length ? "## Files Changed" : "",
    ...filesChanged.map((f) => `- ${f}`),
    notes ? "\n## Notes" : "",
    notes || "",
    "",
  ].filter(Boolean).join("\n");

  await appendFile(relPath, `${body}\n`);
  return { ok: true };
}

export async function upsertAgentContext(
  agentName: string,
  roomCode: string,
  context: string
): Promise<MemoryResult> {
  if (!isEnabled()) return { ok: false, error: "obsidian_disabled" };
  if (!agentName.trim()) return { ok: false, error: "missing_agent" };

  const relPath = path.join("agent-context", `${slugify(agentName) || agentName}.md`);
  const body = [
    `# Agent Context: ${agentName}`,
    `Updated: ${timeStamp()}`,
    `Room: ${roomCode}`,
    "",
    context || "(empty)",
    "",
  ].join("\n");

  await writeFileAtomic(relPath, body);
  return { ok: true };
}

export async function appendDailyLog(
  roomCode: string,
  entry: string,
  by?: string
): Promise<MemoryResult> {
  if (!isEnabled()) return { ok: false, error: "obsidian_disabled" };
  if (!entry.trim()) return { ok: false, error: "missing_entry" };

  const relPath = path.join("daily", `${dateStamp()}.md`);
  const header = `- ${timeStamp()}${by ? ` (${by})` : ""}: ${entry.trim()}`;
  await appendFile(relPath, `${header}\n`);
  return { ok: true };
}

export async function getAgentContext(
  agentName: string
): Promise<{ ok: boolean; content?: string; error?: string }> {
  if (!isEnabled()) return { ok: false, error: "obsidian_disabled" };
  if (!agentName.trim()) return { ok: false, error: "missing_agent" };

  const relPath = path.join("agent-context", `${slugify(agentName) || agentName}.md`);
  const filePath = safeJoin(relPath);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return { ok: true, content };
  } catch (e: any) {
    if (e?.code === "ENOENT") return { ok: true, content: "" };
    return { ok: false, error: "read_failed" };
  }
}

export const obsidianEnabled = isEnabled;
