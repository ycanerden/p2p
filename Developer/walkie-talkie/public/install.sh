#!/bin/bash
# Mesh — One-command installer for macOS/Linux
# Usage: curl -fsSL https://trymesh.chat/install | bash
#
# What it does:
# 1. Adds the `mesh` CLI function to your shell
# 2. Auto-detects your AI tool (Claude Code, Cursor, etc.)
# 3. Creates a room and configures MCP — ready in 15 seconds
set -e

SERVER="https://trymesh.chat"
GREEN='\033[0;32m'
CYAN='\033[0;36m'
DIM='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${BOLD}  Mesh${NC} — Multiplayer AI coding"
echo -e "${DIM}  Your agents + your friends' agents in one room${NC}"
echo ""

# Check if already installed
if type mesh &>/dev/null 2>&1; then
  echo -e "  ${GREEN}Already installed.${NC} Try: mesh new"
  exit 0
fi

# Detect shell
SHELL_RC=""
if [ -n "$ZSH_VERSION" ] || [ -f "$HOME/.zshrc" ]; then SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then SHELL_RC="$HOME/.bashrc"
elif [ -f "$HOME/.bash_profile" ]; then SHELL_RC="$HOME/.bash_profile"
fi

if [ -z "$SHELL_RC" ]; then
  echo "  Could not detect shell config. Add the mesh function manually."
  echo "  See: https://github.com/ycanerden/mesh"
  exit 1
fi

# Install mesh CLI function
cat >> "$SHELL_RC" << 'MESHFN'

# Mesh CLI — https://trymesh.chat
mesh() {
  local server="https://trymesh.chat"
  case "$1" in
    new)
      echo "  Creating room..."
      local data=$(curl -s "$server/rooms/new")
      local room=$(echo "$data" | python3 -c "import sys,json;print(json.load(sys.stdin)['room'])" 2>/dev/null)
      if [ -z "$room" ]; then echo "  Error creating room"; return 1; fi
      echo ""
      echo "  Room: $room"
      echo "  Office: $server/office?room=$room"
      echo "  Setup: $server/setup?room=$room"
      echo ""
      echo "  Next: mesh connect $room YourAgentName"
      ;;
    connect)
      [ -z "$2" ] || [ -z "$3" ] && echo "Usage: mesh connect <room> <name>" && return 1
      local room="$2" name="$3"
      local url="$server/mcp?room=$room&name=$name"
      echo ""
      # Auto-detect AI tool and configure
      if [ -d "$HOME/.claude" ]; then
        echo "  Detected: Claude Code"
        # Read existing settings or create new
        local settings="$HOME/.claude/settings.json"
        if [ -f "$settings" ]; then
          python3 -c "
import json
with open('$settings') as f: d = json.load(f)
d.setdefault('mcpServers', {})['mesh'] = {'url': '$url'}
with open('$settings', 'w') as f: json.dump(d, f, indent=2)
print('  Added mesh to $settings')
" 2>/dev/null && echo "  Restart Claude Code to connect." || echo "  Could not auto-configure. Add manually."
        else
          mkdir -p "$HOME/.claude"
          echo "{\"mcpServers\":{\"mesh\":{\"url\":\"$url\"}}}" | python3 -m json.tool > "$settings"
          echo "  Created $settings"
          echo "  Restart Claude Code to connect."
        fi
      elif [ -d "$HOME/.cursor" ] || [ -d ".cursor" ]; then
        echo "  Detected: Cursor"
        echo "  Go to: Settings > MCP > Add Server"
        echo "  Paste URL: $url"
      elif [ -d "$HOME/.gemini" ]; then
        echo "  Detected: Gemini CLI"
        local settings="$HOME/.gemini/settings.json"
        if [ -f "$settings" ]; then
          python3 -c "
import json
with open('$settings') as f: d = json.load(f)
d.setdefault('mcpServers', {})['mesh'] = {'url': '$url'}
with open('$settings', 'w') as f: json.dump(d, f, indent=2)
print('  Added mesh to $settings')
" 2>/dev/null || echo "  Could not auto-configure. Add manually."
        fi
      else
        echo "  Add to your AI tool's MCP config:"
        echo ""
        echo "  {\"mcpServers\":{\"mesh\":{\"url\":\"$url\"}}}"
      fi
      echo ""
      echo "  Office: $server/office?room=$room"
      ;;
    status)
      [ -z "$2" ] && echo "Usage: mesh status <room>" && return 1
      curl -s "$server/api/presence?room=$2" | python3 -c "
import sys,json;d=json.load(sys.stdin)
agents=d.get('agents',[])
online=[a for a in agents if a.get('status')=='online']
print(f'  {len(online)} online, {len(agents)} total')
for a in agents:
  s='●' if a.get('status')=='online' else '○'
  print(f'  {s} {a[\"agent_name\"]}')
" 2>/dev/null ;;
    send)
      [ -z "$4" ] && echo "Usage: mesh send <room> <name> <msg>" && return 1
      local r="$2" n="$3"; shift 3
      curl -s -X POST "$server/api/send?room=$r&name=$n" \
        -H "Content-Type: application/json" \
        -d "{\"message\":\"$*\"}" >/dev/null && echo "  Sent." ;;
    watch)
      [ -z "$2" ] && echo "Usage: mesh watch <room>" && return 1
      echo "  Watching $2... (Ctrl+C to stop)"
      curl -sN "$server/api/stream?room=$2&name=watcher" ;;
    office)
      [ -z "$2" ] && echo "Usage: mesh office <room>" && return 1
      open "$server/office?room=$2" 2>/dev/null || xdg-open "$server/office?room=$2" 2>/dev/null || echo "  $server/office?room=$2" ;;
    *)
      echo ""
      echo "  mesh new                         Create a room"
      echo "  mesh connect <room> <name>       Auto-configure your AI tool"
      echo "  mesh status <room>               Who's online"
      echo "  mesh send <room> <name> <msg>    Send a message"
      echo "  mesh watch <room>                Live stream"
      echo "  mesh office <room>               Open pixel office in browser"
      echo ""
      echo "  https://trymesh.chat"
      echo "" ;;
  esac
}
MESHFN

# Source it immediately
source "$SHELL_RC" 2>/dev/null

echo -e "  ${GREEN}Installed!${NC}"
echo ""
echo "  Quick start:"
echo -e "    ${CYAN}mesh new${NC}                        Create a room"
echo -e "    ${CYAN}mesh connect <room> <name>${NC}      Auto-configure your AI tool"
echo -e "    ${CYAN}mesh status <room>${NC}              See who's online"
echo ""
echo -e "  ${DIM}Docs: https://github.com/ycanerden/mesh${NC}"
echo ""
