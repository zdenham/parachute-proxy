# Implement Proxy MVP (Phases 1-3 + Live Verification)

## Objective

Implement phases 1-3 of the parachute proxy plan and verify it works with a live end-to-end test against Anthropic.

The full plan is at `plans/claude-code-proxy-plan.md`.

## Acceptance Criteria

1. **Phase 1 - Discovery**: Compatibility spec documented in `plans/compatibility-spec.md` covering Claude Code request shapes, headers, and streaming format for `POST /proxy`
2. **Phase 2 - Foundation**:
   - Bun + TypeScript project initialized (package.json, tsconfig.json, biome)
   - Config loading from `~/.config/parachute-proxy/config.json` with zod validation
   - Env var overrides for API keys (reads from `.env` in project root)
   - Bun HTTP server with `POST /proxy` and `GET /health`
   - Structured JSON logging with request IDs
3. **Phase 3 - Anthropic Backend**:
   - Anthropic provider adapter (translate, stream, classify errors)
   - `POST /proxy` proxies requests to Anthropic API
   - Streaming SSE and non-streaming JSON responses work
   - Error classification (retryable vs fatal) with async-retry
4. **Live Verification**:
   - `~/.config/parachute-proxy/config.json` created with Anthropic config
   - Live e2e test passes: streaming request returns valid SSE events
   - Live e2e test passes: non-streaming request returns valid JSON
   - `bun test` passes all unit tests

## Key Context

- Greenfield project — no existing code besides the plan
- `.env` in project root has `ANTHROPIC_API_KEY`
- Use Bun native HTTP server (not Fastify)
- Use zod for validation, async-retry for retries
- Default listen port: 3080
- Project structure: `src/api/`, `src/config/`, `src/http/`, `src/providers/anthropic/`, `src/router/`, `src/streaming/`, `src/telemetry/`, `src/types/`
- Config path: `~/.config/parachute-proxy/config.json`

## Phases

- [x] Phase 1: Discovery — document compatibility spec
- [x] Phase 2: Foundation — project skeleton, config, server, logging
- [x] Phase 3: Anthropic backend — provider adapter, streaming, retries
- [x] Live verification — e2e tests pass against real Anthropic

<!-- IMPORTANT: Mark phases complete with [x] as you finish them. Update this file immediately after completing each phase - do not batch updates. -->

---
