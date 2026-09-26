#!/bin/bash
# Test: create a new session, send a prompt, verify auto-exit on idle.
# Requires: DEEPSEEK_API_KEY set in environment or .env at repo root.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
CONFIG="$SCRIPT_DIR/cordis.yml"
SESSION_DIR=$(mktemp -d)
SESSION_ID="test-$(date +%s)"

echo "=== Test: create session ==="
echo "Config: $CONFIG"
echo "Session dir: $SESSION_DIR"
echo "Session ID: $SESSION_ID"

# JSON-RPC messages
INIT=$(cat <<EOF
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"cwd":"$REPO_ROOT","provider":"deepseek-official","model":"deepseek-official"}}
EOF
)

PROMPT=$(cat <<EOF
{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":"$SESSION_ID","contentBlocks":[{"type":"text","text":"Say exactly: Hello Yao. Nothing else."}]}}
EOF
)

echo ""
echo "--- Sending initialize + prompt ---"

# Run the stream binary via tsx (source mode)
{
  echo "$INIT"
  sleep 1
  echo "$PROMPT"
  # Keep stdin open for a while so the process can work
  sleep 60
} | DSH_SESSION_ROOT="$SESSION_DIR" \
    DSH_CORDIS_CONFIG="$CONFIG" \
    timeout 120 node --import tsx/esm "$SCRIPT_DIR/../src/bin.ts" 2>/dev/null || EXIT_CODE=$?

echo ""
echo "=== Process exit code: ${EXIT_CODE:-0} ==="
echo "=== Session files ==="
ls -la "$SESSION_DIR/" 2>/dev/null || echo "(empty)"

# Cleanup
rm -rf "$SESSION_DIR"
echo "=== Done ==="
