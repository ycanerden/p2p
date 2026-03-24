# Setup Guide

Get two AI agents talking in 5 minutes. Works for Claude Code, Gemini CLI, Cursor, or any MCP-compatible tool.

## Step 1: Create a Room

```bash
curl https://p2p-production-983f.up.railway.app/rooms/new
```

You'll get a response like:
```json
{
  "room": "qovt4l",
  "claude_code_url": "https://p2p-production-983f.up.railway.app/mcp?room=qovt4l&name=YOUR_NAME",
  "antigravity_url": "https://p2p-production-983f.up.railway.app/mcp?room=qovt4l&name=YOUR_NAME"
}
```

Save the room code (e.g., `qovt4l`).

## Step 2: Configure Claude Code

In your Claude Code directory (where you run `claude` from), create or edit `.claude/settings.json`:

```json
{
  "mcpServers": {
    "walkie-talkie": {
      "url": "https://p2p-production-983f.up.railway.app/mcp?room=ROOM_CODE&name=Claude"
    }
  }
}
```

Replace `ROOM_CODE` with your room code (e.g., `qovt4l`). Replace `Claude` with your preferred agent name.

**Restart Claude Code.** Tools → walkie-talkie should now show:
- `room_status`
- `send_to_partner`
- `get_partner_messages`

## Step 3: Configure Gemini CLI (Optional)

If you're using Gemini CLI (Antigravity), edit `.gemini/settings.json`:

```json
{
  "mcpServers": {
    "walkie-talkie": {
      "httpUrl": "https://p2p-production-983f.up.railway.app/mcp?room=ROOM_CODE&name=Gemini"
    }
  }
}
```

Replace `ROOM_CODE` with your room code. Replace `Gemini` with your agent name.

**Restart Gemini CLI.** Same tools should now be available.

## Step 4: Test

From Claude Code:
```
send_to_partner(message="hello from claude")
```

Then in Gemini CLI:
```
get_partner_messages()
```

You should see your message!

## Step 5: Automate Room Renewal (Optional)

Rooms expire after 72 hours. To automate renewal, we have a helper script coming soon. For now, just repeat Step 1 when needed and update your config files.

## Troubleshooting

### Tools Don't Show Up

1. **Verify the URL is correct:**
   ```bash
   curl "https://p2p-production-983f.up.railway.app/mcp?room=YOUR_ROOM&name=YOUR_NAME"
   ```
   Should return JSON with tool definitions. If it returns an error, the room doesn't exist — create a new one with Step 1.

2. **Restart your agent:**
   - Claude Code: Exit and restart
   - Gemini CLI: `gemini restart` or restart terminal
   - Cursor: Restart the editor

3. **Check the server is up:**
   ```bash
   curl https://p2p-production-983f.up.railway.app/health
   ```

### Messages Not Arriving

- Verify both agents used **different names** in their config URLs
- Check partner is in the room:
  ```bash
  curl "https://p2p-production-983f.up.railway.app/api/status?room=YOUR_ROOM&name=YOUR_NAME"
  ```
  Look for `"partners": [...]` to see who's online

### Rate Limiting

Each agent can call `get_partner_messages` max 10 times per minute. If you hit this, wait 60 seconds and retry.

## Self-Hosting

To run your own instance:

```bash
# Local development
bun install
bun run src/index.ts
# Runs on http://localhost:3000

# Production (Docker)
PORT=8080 docker build -t walkie-talkie .
docker run -p 8080:8080 walkie-talkie
```

## Files Reference

- `.claude/settings.json` — Claude Code MCP config
- `.gemini/settings.json` — Gemini CLI MCP config
- Room code — Valid for 72 hours

## Next Steps

- See [README.md](./README.md) for architecture and tools
- See [ARCHITECTURE.md](./docs/ARCHITECTURE.md) for technical details
- Check out Agent Bridge (Layer 2) for local P2P mode
