#!/usr/bin/env bash
set -euo pipefail

# Smoke test for the parachute-proxy binary or dev server.
# Usage: ./scripts/smoke-test.sh [binary-path]
#
# If a binary path is provided, it starts that binary.
# Otherwise, it starts the dev server with `bun run src/main.ts`.

BINARY="${1:-}"
PORT="${SMOKE_TEST_PORT:-13082}"
PID=""

cleanup() {
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "==> Starting proxy on port $PORT..."
if [ -n "$BINARY" ]; then
  PROXY_PORT="$PORT" "$BINARY" &
  PID=$!
else
  PROXY_PORT="$PORT" bun run src/main.ts &
  PID=$!
fi

# Wait for health endpoint
MAX_WAIT=10
for i in $(seq 1 "$MAX_WAIT"); do
  if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
    echo "==> Proxy is healthy"
    break
  fi
  if [ "$i" -eq "$MAX_WAIT" ]; then
    echo "FAIL: Proxy did not become healthy within ${MAX_WAIT}s"
    exit 1
  fi
  sleep 1
done

# Test 1: Health endpoint
echo "==> Test 1: GET /health"
HEALTH=$(curl -sf "http://127.0.0.1:$PORT/health")
if echo "$HEALTH" | grep -q '"ok"'; then
  echo "   PASS"
else
  echo "   FAIL: $HEALTH"
  exit 1
fi

# Test 2: 404 for unknown routes
echo "==> Test 2: GET /unknown returns 404"
STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/unknown" || true)
if [ "$STATUS" = "404" ]; then
  echo "   PASS"
else
  echo "   FAIL: got $STATUS"
  exit 1
fi

# Test 3: Invalid POST /proxy returns 400
echo "==> Test 3: POST /proxy with invalid body returns 400"
STATUS=$(curl -sf -o /dev/null -w "%{http_code}" \
  -X POST "http://127.0.0.1:$PORT/proxy" \
  -H "Content-Type: application/json" \
  -d '{"model":"test"}' || true)
if [ "$STATUS" = "400" ]; then
  echo "   PASS"
else
  echo "   FAIL: got $STATUS"
  exit 1
fi

# Test 4: POST /v1/messages also routes to proxy handler
echo "==> Test 4: POST /v1/messages with invalid body returns 400"
STATUS=$(curl -sf -o /dev/null -w "%{http_code}" \
  -X POST "http://127.0.0.1:$PORT/v1/messages" \
  -H "Content-Type: application/json" \
  -d '{"model":"test"}' || true)
if [ "$STATUS" = "400" ]; then
  echo "   PASS"
else
  echo "   FAIL: got $STATUS"
  exit 1
fi

echo ""
echo "==> All smoke tests passed!"
