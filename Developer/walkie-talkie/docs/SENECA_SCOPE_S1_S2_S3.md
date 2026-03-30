# Seneca Scope Report (S1/S2/S3)

Date: 2026-03-29
Room: mesh01
Owner: Seneca

## S1: Obsidian Integration Scope

### Decision
Use local filesystem writes to an Obsidian vault path as the MVP.

Why this option first:
- Lowest complexity and fastest to ship.
- No plugin dependency (avoids Obsidian Local REST API install friction).
- Works in headless/server contexts where agents already run.
- Can be upgraded later with optional git sync for multi-machine history.

### MVP Architecture
- New env vars:
  - `OBSIDIAN_VAULT_PATH` (required)
  - `OBSIDIAN_GIT_SYNC` (`0|1`, optional)
  - `OBSIDIAN_GIT_REMOTE` (optional, if sync enabled)
- New module: `src/obsidian-memory.ts`
- Memory writes are plain markdown files under deterministic paths.

### Proposed Functions
- `appendDecision(roomCode, by, summary, rationale, tags?)`
- `appendShip(roomCode, by, title, filesChanged, notes?)`
- `upsertAgentContext(agentName, roomCode, context)`
- `appendDailyLog(roomCode, entry)`
- `getAgentContext(agentName, roomCode)`

### API/MCP Surface (MVP)
- `POST /api/memory/write` (typed entries: decision, ship, context, log)
- `GET /api/memory/context?room=...&agent=...`
- MCP tools:
  - `memory.write_entry`
  - `memory.get_context`

### File Safety + Reliability
- Sanitize paths and force writes inside `OBSIDIAN_VAULT_PATH`.
- Use append-only writes for logs to avoid merge conflicts.
- Use atomic write for context snapshots (write temp + rename).

### Phase 2
- Optional auto-commit + push to a git-backed vault.
- Optional Obsidian Local REST API adapter.

## S2: Google Workspace Skill Scope

### Decision
Use Service Account credentials as MVP auth mode.

Why this option first:
- Headless automation friendly.
- No browser OAuth consent loop for each agent.
- Deterministic permissions and predictable deployment.

### Dependencies
- `googleapis`
- `google-auth-library`

### New Env Vars
- `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_SERVICE_ACCOUNT_FILE`
- `GOOGLE_IMPERSONATE_USER` (optional; for Workspace domain-wide delegation)
- `GOOGLE_DEFAULT_FOLDER_ID` (optional)

### MVP Functions
- `createDoc(title, content): {id, url}`
- `createSlides(title, outline): {id, url}`
- `createSheet(title, data): {id, url}`

### Implementation Notes
- Use Drive API for file creation + permissions.
- Use Docs/Slides/Sheets APIs for content population.
- Return canonical URLs + IDs to agents for handoff.

### MCP Tools (MVP)
- `google.create_doc`
- `google.create_slides`
- `google.create_sheet`

### Security
- Scope only required APIs:
  - `https://www.googleapis.com/auth/documents`
  - `https://www.googleapis.com/auth/presentations`
  - `https://www.googleapis.com/auth/spreadsheets`
  - `https://www.googleapis.com/auth/drive.file`
- Store credentials only in env/secret manager.

## S3: Openclaw Passive Feed Scope

### Decision
Ship read-only SSE subscriber mode first.

Why this option first:
- Reuses existing `/api/stream` path.
- No outbound webhook retries/signature infra required in MVP.
- Token-efficient: no polling; only processes emitted events.

### MVP Design
- Add observer mode to stream endpoint:
  - `GET /api/stream?room=...&name=OpenClaw&observer=1`
- Observer mode behavior:
  - Read-only subscription.
  - No message sends, no task mutation.
  - Optional: suppress presence heartbeat writes.

### Openclaw Side
- Persistent SSE client with reconnect backoff.
- Local buffer + periodic summarization into Openclaw memory.
- Fallback catch-up call: `GET /api/digest?room=...&since=...`.

### Phase 2
- Add signed webhook digest push for offline delivery windows.

## Blockers (Need Creator Input)

1. Obsidian target: local vault path or git-backed vault repo?
2. Google auth: service account available now, or should we implement OAuth fallback?
3. Openclaw runtime: MCP-only, direct API, or CLI daemon?
