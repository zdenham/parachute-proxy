# Progress 002

## Done
- Added `/v1/messages` route alias — Claude Code sets `ANTHROPIC_BASE_URL` and sends to `/v1/messages`, which now routes to the proxy handler alongside `/proxy`
- **LIVE_TEST=1 verified**: All 5 e2e tests pass (4 live proxy + 1 Claude Code round-trip)
- Integration tests (`test/integration/failover.test.ts`) — 8 tests with mock HTTP servers covering: non-streaming failover, streaming failover, circuit breaker integration, no-provider edge case
- Enhanced `/health` endpoint — now returns per-provider status from the health tracker (healthy/degraded, circuit state, success/failure counts); returns 503 when all providers are unhealthy
- Request timeout — upstream fetch calls use `AbortSignal.timeout(config.retry.requestTimeoutMs)` (default 120s)
- Graceful shutdown — SIGINT/SIGTERM handlers call `server.stop(true)` before exit
- Unit tests for proxy handler (5 tests) and health handler (3 tests)
- Updated `config.sample.json` with `requestTimeoutMs`, smoke test with `/v1/messages` check
- Updated compatibility spec with new features
- **Test counts**: 87 unit/integration pass, 9 skip, 0 fail across 13 files; 5 e2e pass with LIVE_TEST=1

## Remaining
- Vertex/Bedrock live testing (requires credentials not available in current environment)
- Mid-stream failover detection (streaming errors after bytes sent are not retried)
- No `~/.aws/credentials` profile-based loading for Bedrock (uses env vars only)
- No automatic ADC token refresh for Vertex (apiKey from config only)

## Context
- `/v1/messages` route was the critical fix for Claude Code compatibility — without it, `ANTHROPIC_BASE_URL` override sent requests to 404
- `createHealthHandler` replaces the old `healthHandler` function — now takes optional `Router` param; existing tests updated
- `requestTimeoutMs` added to config schema with 120s default; existing tests needed updating to include it
