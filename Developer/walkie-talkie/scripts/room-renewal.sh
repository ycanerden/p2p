#!/bin/bash
set -e

# Automatic room renewal
# Rooms expire after 72 hours. This script creates a fresh room and updates both config files.

echo "🔄 Room Renewal Script"
echo ""

# Get server URL
read -p "Server URL [https://trymesh.chat]: " SERVER_URL
SERVER_URL=${SERVER_URL:-https://trymesh.chat}

echo "📍 Creating fresh room..."
RESPONSE=$(curl -s "$SERVER_URL/rooms/new")
NEW_ROOM=$(echo "$RESPONSE" | jq -r '.room')

if [ -z "$NEW_ROOM" ] || [ "$NEW_ROOM" == "null" ]; then
  echo "❌ Failed to create room."
  echo "Response: $RESPONSE"
  exit 1
fi

echo "✅ New room: $NEW_ROOM"
echo ""

# Update Claude Code config
if [ -f ".claude/settings.json" ]; then
  echo "🔧 Updating .claude/settings.json..."
  python3 << PYTHON_SCRIPT
import json
import re

with open('.claude/settings.json', 'r') as f:
    settings = json.load(f)

# Find the walkie-talkie URL and update room code
if 'mcpServers' in settings and 'walkie-talkie' in settings['mcpServers']:
    wt = settings['mcpServers']['walkie-talkie']
    if 'url' in wt:
        # Update room code in URL
        wt['url'] = re.sub(r'room=[^&]+', 'room=$NEW_ROOM', wt['url'])
    elif 'env' in wt and 'ROOM' in wt['env']:
        # Update in env var (stdio bridge)
        wt['env']['ROOM'] = '$NEW_ROOM'

with open('.claude/settings.json', 'w') as f:
    json.dump(settings, f, indent=2)

print("✓ Updated")
PYTHON_SCRIPT
fi

# Update Gemini config
if [ -f ".gemini/settings.json" ]; then
  echo "🔧 Updating .gemini/settings.json..."
  python3 << PYTHON_SCRIPT
import json
import re

with open('.gemini/settings.json', 'r') as f:
    settings = json.load(f)

if 'mcpServers' in settings and 'walkie-talkie' in settings['mcpServers']:
    wt = settings['mcpServers']['walkie-talkie']
    if 'httpUrl' in wt:
        wt['httpUrl'] = re.sub(r'room=[^&]+', 'room=$NEW_ROOM', wt['httpUrl'])

with open('.gemini/settings.json', 'w') as f:
    json.dump(settings, f, indent=2)

print("✓ Updated")
PYTHON_SCRIPT
fi

echo ""
echo "✅ Room renewed!"
echo ""
echo "📋 Next steps:"
echo "   1. Restart Claude Code"
echo "   2. Restart Gemini CLI"
echo "   3. Verify with: room_status()"
echo ""
echo "🔑 New room code: $NEW_ROOM"
echo "🔗 Valid for 72 hours from now"
