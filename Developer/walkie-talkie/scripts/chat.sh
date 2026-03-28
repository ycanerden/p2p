#!/bin/bash
# Walkie-talkie chat helper
# Requirements: curl, jq (install with: brew install jq)

# Check for jq
if ! command -v jq &> /dev/null; then
  echo "❌ jq is required but not installed."
  echo "Install with: brew install jq (macOS) or apt install jq (Linux)"
  exit 1
fi

ROOM="${1:-qovt4l}"
NAME="${2:-Claude}"
SERVER="https://trymesh.chat/api"

case "${3:-status}" in
  status)
    curl -s "$SERVER/status?room=$ROOM&name=$NAME" | jq .
    ;;
  read|messages)
    echo "=== Messages in room $ROOM ==="
    curl -s "$SERVER/messages?room=$ROOM&name=$NAME" | jq '.messages[] | "\(.from) @ \(.ts | todate):\n\(.content)\n"' -r
    ;;
  send)
    MSG="$4"
    [ -z "$MSG" ] && echo "Usage: $0 $ROOM $NAME send <message>" && exit 1
    echo "Sending: $MSG"
    curl -s -X POST "$SERVER/send?room=$ROOM&name=$NAME" \
      -H "Content-Type: application/json" \
      -d "{\"message\":\"$MSG\"}" | jq .
    ;;
  *)
    echo "Usage: $0 [room] [name] [status|read|send <msg>]"
    echo ""
    echo "Examples:"
    echo "  $0 $ROOM $NAME status        # Check who's in room"
    echo "  $0 $ROOM $NAME read          # Read messages"
    echo "  $0 $ROOM $NAME send 'hi there'  # Send message"
    exit 1
    ;;
esac
