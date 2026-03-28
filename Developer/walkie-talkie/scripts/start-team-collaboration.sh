#!/bin/bash
# Start Team Collaboration Daemon
# Launches continuous collaboration for all agents

set -e

# Configuration
ROOM="${ROOM:-c5pe2c}"
SERVER_URL="${SERVER_URL:-https://trymesh.chat}"
CHECK_INTERVAL="${CHECK_INTERVAL:-30}"
AGENTS=("Haiku" "Batman" "Jarvis" "Friday")

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════════╗"
echo "║      Team Collaboration Daemon Launcher                    ║"
echo "║                                                            ║"
echo "║  🤖 Starting continuous AI collaboration...                ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo ""
echo "Configuration:"
echo "  Room: $ROOM"
echo "  Server: $ROOM"
echo "  Check Interval: ${CHECK_INTERVAL}s"
echo "  Agents: ${AGENTS[*]}"
echo ""

# Check if daemon file exists
if [ ! -f "agent-collaboration-daemon.ts" ]; then
  echo -e "${RED}❌ Error: agent-collaboration-daemon.ts not found${NC}"
  echo "Run this from the walkie-talkie directory"
  exit 1
fi

# Check if bun is installed
if ! command -v bun &> /dev/null; then
  echo -e "${RED}❌ Error: bun not found. Install it first: curl -fsSL https://bun.sh/install | bash${NC}"
  exit 1
fi

echo -e "${YELLOW}Starting agents...${NC}"
echo ""

# Function to start an agent
start_agent() {
  local agent_name=$1
  local delay=$2

  sleep "$delay"  # Stagger startup

  echo -e "${GREEN}▶ Launching ${agent_name}...${NC}"

  AGENT_NAME="$agent_name" \
  ROOM="$ROOM" \
  SERVER_URL="$SERVER_URL" \
  CHECK_INTERVAL="$CHECK_INTERVAL" \
  bun agent-collaboration-daemon.ts &

  local pid=$!
  echo -e "${GREEN}  PID: $pid${NC}"
}

# Start all agents in parallel with staggered launches
for i in "${!AGENTS[@]}"; do
  agent="${AGENTS[$i]}"
  delay=$((i * 2))  # 2-second stagger between launches
  start_agent "$agent" "$delay" &
done

# Wait for all background jobs
wait

echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ All agents launched!${NC}"
echo ""
echo "Agents running:"
for agent in "${AGENTS[@]}"; do
  echo -e "  ${GREEN}✓${NC} $agent"
done
echo ""
echo "💬 Check room $ROOM to see collaboration in action!"
echo ""
echo "To stop:"
echo -e "  ${YELLOW}pkill -f 'agent-collaboration-daemon'${NC}"
echo ""
echo "To view logs:"
echo -e "  ${YELLOW}ps aux | grep agent-collaboration${NC}"
echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
