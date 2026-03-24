#!/bin/bash
# Manual SSE integration test
# Tests the /api/stream endpoint for real-time message delivery

set -e

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
ROOM=$(openssl rand -hex 3)
AGENT_A="agent-a-$$"
AGENT_B="agent-b-$$"

echo "🔄 SSE Integration Test"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Server: $SERVER_URL"
echo "Room:   $ROOM"
echo "Agents: $AGENT_A, $AGENT_B"
echo ""

# Step 1: Create room
echo "1️⃣  Creating room..."
curl -s "$SERVER_URL/rooms/new" | jq .

# Step 2: Join both agents
echo ""
echo "2️⃣  Joining agents..."
curl -s "$SERVER_URL/api/status?room=$ROOM&name=$AGENT_A" | jq .
curl -s "$SERVER_URL/api/status?room=$ROOM&name=$AGENT_B" | jq .

# Step 3: Test SSE stream connection
echo ""
echo "3️⃣  Testing SSE stream (first 2 messages, 15s timeout)..."
echo "    (If SSE_ENABLED=false, this will fail with 503)"
echo ""

# Start SSE listener in background, capture first 2 messages or timeout after 15s
{
  timeout 15 curl -s "$SERVER_URL/api/stream?room=$ROOM&name=$AGENT_A" 2>/dev/null | \
    head -n 4 | \
    jq -R 'select(startswith("data:")) | .[6:] | fromjson' || true
} &
LISTENER_PID=$!

# Give SSE connection time to establish
sleep 1

# Step 4: Send message from agent B
echo ""
echo "4️⃣  Sending message from $AGENT_B..."
curl -s -X POST \
  "$SERVER_URL/api/send?room=$ROOM&name=$AGENT_B" \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello from agent B!"}' | jq .

# Step 5: Send another message
sleep 1
echo ""
echo "5️⃣  Sending second message from $AGENT_B..."
curl -s -X POST \
  "$SERVER_URL/api/send?room=$ROOM&name=$AGENT_B" \
  -H "Content-Type: application/json" \
  -d '{"message":"Message 2 from agent B"}' | jq .

# Wait for SSE listener to finish
wait $LISTENER_PID 2>/dev/null || true

echo ""
echo "6️⃣  Testing polling fallback (if SSE not enabled)..."
curl -s "$SERVER_URL/api/messages?room=$ROOM&name=$AGENT_A" | jq .

echo ""
echo "✅ SSE Integration Test Complete"
echo ""
echo "📝 Notes:"
echo "  - If /api/stream returns 503, SSE is disabled (set SSE_ENABLED=true)"
echo "  - If you see JSON messages printed, SSE streaming is working!"
echo "  - Polling fallback always works regardless of SSE status"
