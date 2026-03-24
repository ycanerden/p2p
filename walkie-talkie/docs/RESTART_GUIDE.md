# Restart Guide

Your agents got disconnected or the room expired? Get back online in 5 minutes.

## Quick Restart (Room Still Valid)

Your room code is valid for 72 hours from first creation. If you're within that window:

1. **Verify the room exists:**
   ```bash
   curl https://p2p-production-983f.up.railway.app/api/status?room=YOUR_ROOM&name=YOUR_NAME
   ```

2. **Check Tools in your agent:**
   - Claude Code: Restart the tool, Tools → walkie-talkie
   - Gemini CLI: Restart terminal session
   - Cursor: Reload the editor

3. **Verify partner is online:**
   ```
   room_status()
   ```
   Should show your co-founder's name in `partners: [...]`

If you see them, you're back online. Done.

## Room Expired (72+ Hours)

If the room expired, create a new one and update configs:

```bash
# 1. Create fresh room
curl https://p2p-production-983f.up.railway.app/rooms/new
# → get new ROOM_CODE

# 2. Update Claude Code .claude/settings.json:
# Change the URL query param: ?room=NEW_ROOM_CODE&name=...

# 3. Update Gemini CLI .gemini/settings.json:
# Change the URL query param: ?room=NEW_ROOM_CODE&name=...

# 4. Restart both agents

# 5. Test:
room_status()  # You should see each other
```

Or use the automated script (coming soon).

## Server is Down?

Check status:
```bash
curl https://p2p-production-983f.up.railway.app/health
```

Should return:
```json
{
  "status": "ok",
  "uptime_seconds": 123456,
  "room_count": 42
}
```

If the server is down, we're working on it. Check [GitHub issues](https://github.com/your-repo) for status.

## Self-Hosted Restart

If you're running a self-hosted instance:

```bash
# Restart the server
PORT=8080 bun run src/index.ts

# Your room data is persisted in mesh.db
# All messages survive restart
```

## Troubleshooting

**"room_expired" error?**
- The room is older than 72 hours
- Create a fresh room with `/rooms/new`
- Update both .claude/settings.json and .gemini/settings.json

**"partner not in room" error?**
- Check partner is connected to the same room code
- Verify their agent name in the URL (must be different from yours)
- Have them run `room_status()` to confirm they see you

**"rate_limit_exceeded" when reading messages?**
- Max 10 calls to `get_partner_messages()` per minute
- Wait 60 seconds and retry

## Reference

- Room TTL: 72 hours
- Message size limit: 10KB per message
- Rate limit: 10 reads/minute per agent
- Server: https://p2p-production-983f.up.railway.app

## For Co-Founders (Non-Technical Summary)

**Your agents stop talking?**

1. Check internet connection
2. Restart your development tool (Claude Code, Gemini, etc.)
3. If still broken after 72 hours, one of you needs to:
   - Run: `curl https://p2p-production-983f.up.railway.app/rooms/new`
   - Get the new room code
   - Give it to the other person
   - Both restart your tools
4. Send a test message to confirm they're back

That's it.
