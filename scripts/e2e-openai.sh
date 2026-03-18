#!/usr/bin/env bash
set -euo pipefail

# E2E test: Claude Code → parachute-proxy → OpenAI
#
# Starts the proxy with OpenAI as the only provider, then runs Claude Code
# prompts that exercise streaming + tool use through the translation pipeline.
#
# Prerequisites:
#   - OPENAI_API_KEY env var (or in .env)
#   - claude CLI on PATH
#   - bun installed
#
# Usage: ./scripts/e2e-openai.sh
# Optional: E2E_OPENAI_MODEL=gpt-4o ./scripts/e2e-openai.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PORT=13083
OPENAI_MODEL="${E2E_OPENAI_MODEL:-gpt-4o}"
TIMEOUT_SECS=120
PROXY_PID=""
PROXY_LOG="/tmp/parachute-e2e-proxy.log"
CONFIG_FILE="/tmp/parachute-e2e-config.json"
PASSED=0
FAILED=0
TOTAL=4

cleanup() {
  if [ -n "$PROXY_PID" ]; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
  rm -f "$CONFIG_FILE"
  rm -f /tmp/parachute-e2e-test.txt
  rm -f /tmp/parachute-e2e-multi.json
}
trap cleanup EXIT

# --- Prerequisite checks ---

if ! command -v claude &>/dev/null; then
  echo "FAIL: 'claude' CLI not found on PATH"
  exit 1
fi

if ! command -v bun &>/dev/null; then
  echo "FAIL: 'bun' not found on PATH"
  exit 1
fi

# Load .env if it exists (for OPENAI_API_KEY)
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "FAIL: OPENAI_API_KEY is not set"
  exit 1
fi

# --- Write temp config ---

cat > "$CONFIG_FILE" <<EOF
{
  "server": { "host": "127.0.0.1", "port": $PORT },
  "providers": {
    "openai": {
      "enabled": true,
      "apiKey": "$OPENAI_API_KEY",
      "modelMap": {
        "claude-sonnet-4-6": "$OPENAI_MODEL",
        "claude-sonnet-4-20250514": "$OPENAI_MODEL"
      }
    },
    "anthropic": { "enabled": false },
    "vertex": { "enabled": false },
    "bedrock": { "enabled": false }
  },
  "routing": { "providerOrder": ["openai"] }
}
EOF

# --- Start proxy ---

echo "==> Starting proxy on port $PORT (OpenAI provider, model: $OPENAI_MODEL)..."
cd "$PROJECT_DIR"
CONFIG_PATH="$CONFIG_FILE" bun run src/main.ts > "$PROXY_LOG" 2>&1 &
PROXY_PID=$!

# Wait for health
MAX_WAIT=10
for i in $(seq 1 "$MAX_WAIT"); do
  if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
    echo "==> Proxy healthy"
    break
  fi
  if [ "$i" -eq "$MAX_WAIT" ]; then
    echo "FAIL: Proxy did not become healthy within ${MAX_WAIT}s"
    echo "--- Proxy log ---"
    cat "$PROXY_LOG"
    exit 1
  fi
  sleep 1
done

# --- Helper: run claude with timeout ---

run_claude() {
  local prompt="$1"
  local output_file
  output_file=$(mktemp /tmp/parachute-e2e-output.XXXXXX)

  # Run claude in background with a kill timer
  (
    ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" \
    ANTHROPIC_API_KEY="not-needed-but-required" \
    DISABLE_PROMPT_CACHING=1 \
      claude -p \
        --dangerously-skip-permissions \
        --model claude-sonnet-4-6 \
        --allowedTools "Bash Read Write Edit" \
        "$prompt" \
      > "$output_file" 2>&1
  ) &
  local claude_pid=$!

  # Timer to kill if hung
  (
    sleep "$TIMEOUT_SECS"
    kill "$claude_pid" 2>/dev/null || true
  ) &
  local timer_pid=$!

  wait "$claude_pid" 2>/dev/null || true
  kill "$timer_pid" 2>/dev/null || true
  wait "$timer_pid" 2>/dev/null || true

  cat "$output_file"
  rm -f "$output_file"
}

record_result() {
  local test_name="$1"
  local pass="$2"
  local output="$3"

  if [ "$pass" = "true" ]; then
    echo "    PASS"
    PASSED=$((PASSED + 1))
  else
    echo "    FAIL"
    echo "    --- Claude output ---"
    echo "$output" | head -20
    echo "    --- End output ---"
    FAILED=$((FAILED + 1))
  fi
}

# --- Test 1: Basic streaming ---

echo ""
echo "==> Test 1: Basic streaming (text only)"
OUTPUT=$(run_claude "What is 2+2? Reply with only the number.")
if echo "$OUTPUT" | grep -q "4"; then
  record_result "Basic streaming" "true" "$OUTPUT"
else
  record_result "Basic streaming" "false" "$OUTPUT"
fi

# --- Test 2: Tool use — file write + read ---

echo ""
echo "==> Test 2: Tool use — file write + read"
rm -f /tmp/parachute-e2e-test.txt
OUTPUT=$(run_claude "Create a file at /tmp/parachute-e2e-test.txt containing exactly 'hello from openai proxy'. Then read it back and confirm the contents.")
if [ -f /tmp/parachute-e2e-test.txt ] && grep -q "hello from openai proxy" /tmp/parachute-e2e-test.txt; then
  record_result "Tool use file write+read" "true" "$OUTPUT"
else
  record_result "Tool use file write+read" "false" "$OUTPUT"
fi

# --- Test 3: Tool use — bash execution ---

echo ""
echo "==> Test 3: Tool use — bash execution"
OUTPUT=$(run_claude "Use the Bash tool to run 'echo PROXY_E2E_OK' and tell me what it output.")
if echo "$OUTPUT" | grep -q "PROXY_E2E_OK"; then
  record_result "Tool use bash" "true" "$OUTPUT"
else
  record_result "Tool use bash" "false" "$OUTPUT"
fi

# --- Test 4: Multi-tool conversation ---

echo ""
echo "==> Test 4: Multi-tool conversation"
rm -f /tmp/parachute-e2e-multi.json
OUTPUT=$(run_claude "Create a file at /tmp/parachute-e2e-multi.json with the content '{\"a\":1}'. Then use Bash to run 'cat /tmp/parachute-e2e-multi.json | jq .a' and tell me the result.")
if [ -f /tmp/parachute-e2e-multi.json ] && echo "$OUTPUT" | grep -q "1"; then
  record_result "Multi-tool" "true" "$OUTPUT"
else
  record_result "Multi-tool" "false" "$OUTPUT"
fi

# --- Summary ---

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "==> All $TOTAL E2E tests passed!"
  exit 0
else
  echo "==> $FAILED/$TOTAL tests failed ($PASSED passed)"
  echo "    Proxy log: $PROXY_LOG"
  exit 1
fi
