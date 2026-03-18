# Progress 001

## Done
- Created `test/e2e/claude-code-proxy.test.ts` — launches proxy, runs `claude -p` with `ANTHROPIC_BASE_URL` pointing at proxy, verifies round-trip. Gated behind `LIVE_TEST=1`.
- **Phase 4**: Circuit breaker (`src/router/circuit-breaker.ts`), health tracker (`src/router/health.ts`), router/selector (`src/router/selector.ts`). Proxy handler refactored to use router with automatic failover across provider chain.
- **Phase 5**: Vertex AI adapter (`src/providers/vertex/adapter.ts`) — rawPredict/streamRawPredict endpoints, Bearer auth, anthropic_version in body.
- **Phase 6**: AWS Bedrock adapter (`src/providers/bedrock/adapter.ts`) with minimal SigV4 signer (`src/providers/bedrock/signer.ts`). Credentials from env vars or config.
- **Phase 7**: `bun build --compile` script, `config.sample.json`, `scripts/smoke-test.sh`. Binary compiles to 59MB, smoke tests pass against both dev server and binary.
- Config schema expanded: `routing.providerOrder`, `circuitBreaker.*`, `providers.vertex`, `providers.bedrock`.
- 71 unit tests passing across 8 test files. Smoke tests pass.

## Remaining
- `LIVE_TEST=1` run of Claude Code proxy test not verified (requires active `claude` CLI + credentials in session)
- `LIVE_TEST=1` run of existing live proxy tests not re-verified
- Vertex/Bedrock live testing not possible without credentials
- No integration tests with mock provider servers for failover scenarios
- No mid-stream failover detection (streaming errors after bytes sent are not retried/failed over)

## Context
- Proxy handler now takes `(config, router)` — breaking change from before where it only took `(config)`
- Bedrock SigV4 signer is minimal (no profile-based credential loading from `~/.aws/credentials`)
- Vertex adapter assumes ADC token is passed as `apiKey` in config — no automatic token refresh
