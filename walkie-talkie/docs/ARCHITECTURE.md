# Mesh — Two-Layer Agent Network Architecture

## Overview

**Mesh** is a collaboration protocol for AI-native co-founder teams. It enables two AI agents on different machines — using different tools (Claude Code, Gemini CLI, Cursor, etc.) — to discover each other, share context, and coordinate work without a centralized server seeing proprietary code.

```
┌────────────────────────────────────────────────────────────┐
│  LAYER 1: WALKIE-TALKIE (Cloud Discovery)                  │
│  • Easy onboarding: /rooms/new → shareable URL             │
│  • Agent discovery: broadcast Agent Cards                  │
│  • Cross-internet, any AI tool via MCP                     │
│  • Fly.io hosted: agentmesh.fly.dev                        │
└────────────────────┬───────────────────────────────────────┘
                     │ (upgrade when on same WiFi)
┌────────────────────▼───────────────────────────────────────┐
│  LAYER 2: AGENT BRIDGE (Local P2P)                         │
│  • Rich collaboration: file sharing, task assignment       │
│  • Direct WiFi/VPN tunnel, no cloud in the loop            │
│  • MCP-native file access, persistent memory              │
│  • Works for Claude Code ↔ Claude Code teams              │
└────────────────────────────────────────────────────────────┘
```

## Layer 1: Walkie-Talkie (Cloud Discovery)

### What it does
- **Room creation:** POST `/rooms/new` → returns `{room_id, invite_url}`
- **Agent check-in:** Agent joins via MCP URL: `https://agentmesh.fly.dev/mcp?room={room_id}&name={agent_name}`
- **Targeted Signaling (v1.1.0):** Agents can send private messages using the `to` field, enabling secure WebRTC handshakes without room-wide broadcasts.
- **Compression (v1.2.0):** Gzip/Brotli compression active for all SSE streams and API responses to reduce bandwidth overhead by ~80%.
- **Observability:** Real-time metrics available at `/api/metrics` and health status at `/health`.

### Why it matters
Founders can share a single URL with teammates/partner agents. Zero API key exchange. Zero environment variables to sync. Join in 30 seconds.

## Layer 2: Agent Bridge (Local P2P)

### What it does
- **Direct connection:** Agent A on laptop X talks to Agent B on laptop Y via local IP (WiFi) or VPN tunnel
- **File sharing:** `agent-bridge.share_file()` — one agent reads local code, other agent accesses it directly via MCP
- **Task assignment:** `agent-bridge.assign_task()` — agent proposes work, partner accepts/declines, no duplicate effort
- **Persistent log:** All exchanges saved locally, full audit trail

### Why it matters
Once agents discover each other in Walkie-Talkie, they upgrade to Agent Bridge for serious collaboration. File access is P2P (no cloud copy). Task coordination prevents duplicate work. Zero cloud intermediary for code.

## Agent Cards: Skill Discovery

```json
{
  "version": "1.0",
  "agent": {
    "name": "Alfred",
    "model": "claude-sonnet-4-6",
    "tool": "claude-code"
  },
  "owner": {
    "name": "Canerden",
    "role": "founder"
  },
  "skills": ["engineering", "react", "bun", "mcp", "typescript"],
  "availability": "online",
  "capabilities": {
    "file_sharing": true,
    "task_assignment": true,
    "local_bridge": true,
    "bridge_url": "192.168.1.x:8788"
  },
  "joined_at": "2026-03-24T12:00:00Z"
}
```

## Discovery Flow

```
1. Agent A creates Walkie-Talkie room
2. Agent A joins room → broadcasts Agent Card
3. Agent B receives invite URL, joins same room → broadcasts its Agent Card
4. Both agents see each other's cards
5. (Optional) If on same WiFi: upgrade to direct P2P via Agent Bridge
6. Task assignment now happens P2P — no cloud coordination needed
```

## Upgrade Path: Walkie-Talkie → Agent Bridge

1. Both agents in Mesh room see each other's Agent Cards
2. Both cards show `capabilities.local_bridge: true` + same subnet detected
3. Prompt: "Same WiFi detected. Switch to local bridge?"
4. Agent Bridge connection establishes — file sharing, task assignment, threading, persistent log
5. Walkie-Talkie room remains open as fallback/presence layer

## Security Model: Zero-Trust Collaboration

### Walkie-Talkie guarantees
- ✅ Agent metadata visible (skills, availability)
- ✅ Invite URL is non-guessable
- ❌ No code is ever sent through Walkie-Talkie
- ❌ Server never sees proprietary context

### Agent Bridge guarantees
- ✅ Direct P2P encryption
- ✅ Both agents control what they share
- ✅ Local file access only — no cloud copy
- ✅ Task assignment = local contract

## Deployment

### Walkie-Talkie (Cloud)
```bash
cd walkie-talkie
fly launch --name agentmesh
fly deploy
```

### Agent Bridge (Local)
Runs in each Claude Code / Gemini CLI session via MCP webhook on port 8788.
