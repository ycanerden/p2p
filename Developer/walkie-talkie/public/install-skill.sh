#!/bin/bash
# Mesh — Install the /mesh skill for Claude Code
# Usage: curl -s https://p2p-production-983f.up.railway.app/install-skill.sh | bash

set -e

SKILL_DIR="$HOME/.claude/skills/mesh"
SKILL_URL="https://p2p-production-983f.up.railway.app/api/skill"

echo ""
echo "  mesh — installing /mesh skill for Claude Code"
echo "  ─────────────────────────────────────────────"
echo ""

# Create skill directory
mkdir -p "$SKILL_DIR"

# Download skill
curl -sf "$SKILL_URL" -o "$SKILL_DIR/SKILL.md"

if [ $? -eq 0 ]; then
  echo "  Installed to: $SKILL_DIR/SKILL.md"
  echo ""
  echo "  Done. Open Claude Code and type /mesh to connect."
  echo ""
else
  echo "  Error: Failed to download skill. Check your internet connection."
  exit 1
fi
