#!/bin/bash
set -e

# Walkie-Talkie Quick Start
# Creates a room and configures Claude Code in ~30 seconds

echo "🚀 Walkie-Talkie Quick Start"
echo ""

# Detect OS
if [[ "$OSTYPE" == "darwin"* ]]; then
  SETTINGS_FILE=".claude/settings.json"
else
  SETTINGS_FILE=".claude/settings.json"
fi

# Check if settings file exists
if [ ! -f "$SETTINGS_FILE" ]; then
  echo "❌ $SETTINGS_FILE not found."
  echo "   Run this script from your Claude Code working directory."
  exit 1
fi

echo "📍 Step 1: Create a room on the server..."
ROOM_RESPONSE=$(curl -s https://trymesh.chat/rooms/new)
ROOM_CODE=$(echo "$ROOM_RESPONSE" | jq -r '.room')

if [ -z "$ROOM_CODE" ] || [ "$ROOM_CODE" == "null" ]; then
  echo "❌ Failed to create room. Check your internet connection."
  echo "Response: $ROOM_RESPONSE"
  exit 1
fi

echo "✓ Room created: $ROOM_CODE"
echo ""

# Prompt for agent name
read -p "👤 What is your agent name? (default: Claude): " AGENT_NAME
AGENT_NAME=${AGENT_NAME:-Claude}

echo ""
echo "🔧 Step 2: Configure Claude Code..."

# Backup original settings
cp "$SETTINGS_FILE" "$SETTINGS_FILE.backup"
echo "   (backed up to $SETTINGS_FILE.backup)"

# Update settings.json with walkie-talkie config
# Using Python for robust JSON manipulation
python3 << PYTHON_SCRIPT
import json

settings_file = "$SETTINGS_FILE"

# Read existing settings
with open(settings_file, 'r') as f:
    settings = json.load(f)

# Add/update walkie-talkie MCP server
if 'mcpServers' not in settings:
    settings['mcpServers'] = {}

settings['mcpServers']['walkie-talkie'] = {
    "url": f"https://trymesh.chat/mcp?room=$ROOM_CODE&name=$AGENT_NAME"
}

# Write back
with open(settings_file, 'w') as f:
    json.dump(settings, f, indent=2)

print(f"✓ Updated {settings_file}")
PYTHON_SCRIPT

echo ""
echo "✨ Step 3: Igniting the 'Zero-to-Mesh' Magic for Can & Vincent..."
echo ""

# Start the mDNS bridge in the background if it's not already running
if ! pgrep -f "mdns-bridge.ts" > /dev/null; then
  echo "   [mDNS] Broadcasting local presence..."
  ROOM=$ROOM_CODE bun run /Users/canerden/mdns-bridge.ts &> .agent-bridge/mdns.log &
fi

# Attempt to open the dashboard and manifesto (macOS)
if [[ "$OSTYPE" == "darwin"* ]]; then
  echo "   [Dashboard] Opening the Trust Dashboard and Manifesto..."
  open dashboard.html || true
  open mesh-manifesto.html || true
fi

echo ""
echo "✅ Setup complete! You are now a Wizard. 🧙‍♂️"
echo ""
echo "📋 What to do next:"
echo "   1. Restart Claude Code or Gemini CLI"
echo "   2. Ask your agent to call: room_status()"
echo "   3. Test the magic: handoff_to_partner(targetAgent='Vincent', ...)"
echo ""
echo "🔑 Room code: $ROOM_CODE"
echo "👤 Agent name: $AGENT_NAME"
echo ""
echo "💡 Share this exact command with Vincent to connect instantly:"
echo "   curl -s https://trymesh.chat/rooms/$ROOM_CODE/join | bash"
echo ""
echo "📖 For more info, see the Zero-to-Mesh Manifesto (manifesto.md)"
