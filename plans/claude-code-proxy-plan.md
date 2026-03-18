# Parachute Proxy Plan

## Goal

Build a local proxy server for Claude Code that:

- runs as a single native binary produced from a 100% TypeScript codebase
- uses Bun for development, build, and binary compilation
- detects upstream downtime and automatically forwards requests to alternate providers
- supports Anthropic, Vertex AI, and AWS Bedrock provider backends
- reads API credentials and defaults from a global user-level config location
- exposes a single proxy endpoint that internally forwards to the correct upstream path

## Scope

This project should focus on being a reliable local compatibility layer rather than a full gateway product. The first version should:

- expose one local HTTP endpoint, `POST /proxy`, compatible with the Claude Code workflows we need to support
- proxy request and streaming response traffic to configured upstream providers
- apply health checks, circuit breaking, retries, and failover rules
- centralize logging, metrics, and request tracing for debugging provider issues
- ship as a Bun-compiled native executable for macOS first, with Linux support as a follow-up if needed
- use one live end-to-end proxy test as the first implementation step so later work follows TDD

## Assumptions

- Claude Code can be pointed at a local base URL or proxy endpoint.
- We only need to support the subset of Anthropic-style request shapes Claude Code actually uses.
- Provider-specific auth and endpoint details can be normalized behind a shared internal interface.
- Global config should live outside the repo, for example under `~/.config/parachute-proxy/`.
- Secrets should never be stored in the project workspace or committed to git.

## Non-Goals

- Multi-tenant auth or team-level secret management
- Hosted deployment in the first phase
- Full UI dashboard in the first phase
- Perfect feature parity across all provider-specific model capabilities on day one

## Architecture Overview

### System Context

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Developer Machine                            │
│                                                                     │
│  ┌──────────────┐         ┌──────────────────────────┐              │
│  │              │  POST   │                          │              │
│  │  Claude Code │────────>│   Parachute Proxy        │              │
│  │              │<────────│   localhost:3080          │              │
│  │              │ SSE     │                          │              │
│  └──────────────┘ stream  └──────────┬───────────────┘              │
│                                      │                              │
│                           ┌──────────┴──────────┐                   │
│                           │  ~/.config/          │                   │
│                           │  parachute-proxy/    │                   │
│                           │  config.json         │                   │
│                           └─────────────────────┘                   │
└──────────────────────────────────────┬──────────────────────────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  │                  │
                    ▼                  ▼                  ▼
          ┌─────────────────┐ ┌──────────────┐ ┌──────────────────┐
          │   Anthropic API │ │  Vertex AI   │ │  AWS Bedrock     │
          │   api.anthropic │ │  (regional)  │ │  (regional)      │
          │   .com          │ │              │ │                  │
          └─────────────────┘ └──────────────┘ └──────────────────┘
```

### Request Flow (Happy Path)

```
Claude Code                Proxy                    Router              Provider
    │                        │                        │                    │
    │  POST /proxy           │                        │                    │
    │  {model, messages}     │                        │                    │
    │───────────────────────>│                        │                    │
    │                        │  select(model)         │                    │
    │                        │───────────────────────>│                    │
    │                        │                        │                    │
    │                        │  provider: anthropic   │                    │
    │                        │<───────────────────────│                    │
    │                        │                        │                    │
    │                        │  POST /v1/messages  (translated request)   │
    │                        │───────────────────────────────────────────>│
    │                        │                        │                    │
    │                        │  200 OK  text/event-stream                 │
    │                        │<───────────────────────────────────────────│
    │                        │                        │                    │
    │  200 OK                │                        │                    │
    │  text/event-stream     │                        │                    │
    │<───────────────────────│                        │                    │
    │                        │                        │                    │
    │  event: content_block  │  (SSE pass-through)    │                    │
    │<───────────────────────│<───────────────────────────────────────────│
    │  ...                   │                        │                    │
    │  event: message_stop   │                        │                    │
    │<───────────────────────│                        │                    │
    │                        │  record: success       │                    │
    │                        │───────────────────────>│                    │
    │                        │                        │                    │
```

### Request Flow (Failover)

```
Claude Code                Proxy              Router            Primary       Fallback
    │                        │                  │                  │              │
    │  POST /proxy           │                  │                  │              │
    │───────────────────────>│  select(model)   │                  │              │
    │                        │─────────────────>│                  │              │
    │                        │  anthropic       │                  │              │
    │                        │<─────────────────│                  │              │
    │                        │                  │                  │              │
    │                        │  POST /v1/messages                  │              │
    │                        │────────────────────────────────────>│              │
    │                        │                  │                  │              │
    │                        │  503 Service Unavailable            │              │
    │                        │<────────────────────────────────────│              │
    │                        │                  │                  │              │
    │                        │  retry x2...     │                  │              │
    │                        │────────────────────────────────────>│              │
    │                        │  503 again       │                  │              │
    │                        │<────────────────────────────────────│              │
    │                        │                  │                  │              │
    │                        │  budget exhausted│                  │              │
    │                        │  mark degraded   │                  │              │
    │                        │─────────────────>│                  │              │
    │                        │  next: vertex    │                  │              │
    │                        │<─────────────────│                  │              │
    │                        │                  │                  │              │
    │                        │  POST (translated for Vertex)       │              │
    │                        │────────────────────────────────────────────────────>
    │                        │                  │                  │              │
    │  200 OK (stream)       │  200 OK (stream from Vertex)       │              │
    │<───────────────────────│<──────────────────────────────────────────────────│
    │                        │                  │                  │              │
```

### Component Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                         Bun HTTP Server                           │
│                                                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────────┐  │
│  │ POST /proxy │  │ GET /health │  │ GET /metrics (optional)  │  │
│  └──────┬──────┘  └─────────────┘  └──────────────────────────┘  │
│         │                                                         │
└─────────┼─────────────────────────────────────────────────────────┘
          │
          ▼
┌──────────────────┐     ┌──────────────────────────────────────────┐
│  Request Handler │     │              Config Loader                │
│                  │     │  ~/.config/parachute-proxy/config.json   │
│  - parse body    │     │  + env var overrides                     │
│  - validate      │     │  + zod schema validation                 │
│  - attach reqId  │     └──────────────────────────────────────────┘
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│                      Router / Selector                            │
│                                                                  │
│  model alias ──> provider chain ──> pick first healthy provider  │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────────────────────────┐  │
│  │  Health Tracker   │  │  Circuit Breaker (per provider)      │  │
│  │                   │  │                                      │  │
│  │  - success/fail   │  │  CLOSED ──5xx──> OPEN               │  │
│  │    counters       │  │    ▲               │ (cooldown)      │  │
│  │  - degraded flag  │  │    │               ▼                 │  │
│  │  - last probe ts  │  │  CLOSED <──ok── HALF-OPEN           │  │
│  └──────────────────┘  └──────────────────────────────────────┘  │
└────────┬─────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Provider Abstraction Layer                      │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │  Anthropic    │  │  Vertex AI   │  │  AWS Bedrock          │  │
│  │              │  │              │  │                       │  │
│  │  translate() │  │  translate() │  │  translate()          │  │
│  │  stream()    │  │  stream()    │  │  stream()             │  │
│  │  classify()  │  │  classify()  │  │  classify() + sign()  │  │
│  └──────────────┘  └──────────────┘  └───────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│                      Observability                                │
│                                                                  │
│  - structured JSON logs     - request ID propagation             │
│  - provider tag per request - stream lifecycle events            │
│  - retry/failover counters  - circuit breaker state changes      │
└──────────────────────────────────────────────────────────────────┘
```

### Circuit Breaker State Machine

```
                    ┌──────────┐
         ┌─────────│  CLOSED   │◄─────────────────────┐
         │         │ (healthy) │                       │
         │         └─────┬─────┘                       │
         │               │                             │
         │     error count exceeds                     │
         │     threshold within window          probe request
         │               │                      succeeds
         │               ▼                             │
         │         ┌──────────┐    cooldown      ┌─────┴──────┐
         │         │   OPEN    │────expires──────>│ HALF-OPEN  │
         │         │ (tripped) │                  │ (probing)  │
         │         └──────────┘                  └─────┬──────┘
         │                                             │
         │                                       probe request
         │                                       fails
         │                                             │
         │                                             ▼
         │                                       ┌──────────┐
         └───────────────────────────────────────│   OPEN    │
                   (reset on sustained           │ (re-trip) │
                    success)                     └──────────┘
```

## Proposed Architecture (Detail)

### 1. Local Proxy Server

Responsibilities:

- listen on `localhost` on a configurable port
- expose a single `POST /proxy` route
- accept inbound Claude-compatible HTTP requests and infer the upstream target path from the payload/config
- validate config and auth state before forwarding
- select an upstream provider using routing and failover policy
- stream upstream events back to the client with minimal transformation so mid-stream failures remain visible

Suggested modules:

- `src/server/` for Bun HTTP server setup and route wiring
- `src/http/` for request parsing, streaming, headers, and response translation
- `src/api/` for Claude-compatible endpoint handlers

Implementation note:

- prefer Bun's native HTTP server to keep the proxy small and easier to bundle
- only introduce Fastify if routing, hooks, or streaming compatibility become materially easier with it

### 2. Provider Abstraction Layer

Define a shared interface for all backends:

- model discovery and capability metadata
- request translation from proxy format to provider-native path, headers, and body
- streaming response normalization with event pass-through where possible
- error classification into retryable, throttled, auth, and fatal categories
- health probe logic

Suggested modules:

- `src/providers/base.ts`
- `src/providers/anthropic/`
- `src/providers/vertex/`
- `src/providers/bedrock/`

### 3. Router and Failover Engine

Responsibilities:

- choose provider based on ordered preference, weights, and model mapping
- maintain provider health state
- open and close circuit breakers based on error rates and probe recovery
- retry safely on transient failures before failing over
- avoid retrying non-idempotent flows unless explicitly allowed

Suggested policies:

- primary provider per model alias
- fallback chain per model alias
- cooldown windows after repeated upstream failures
- passive health detection from live traffic plus active background probes
- mark providers degraded on repeated HTTP 5xx responses
- mark providers degraded on interrupted or malformed streaming responses

Retry strategy:

- use `async-retry` for bounded retry behavior because its API matches the control flow we need
- retry transport failures, timeouts, and retryable `5xx` responses
- do not retry auth failures, validation failures, or clearly non-retryable provider errors
- only fail over once a retry budget is exhausted or a stream terminates mid-flight in a retryable way

Suggested modules:

- `src/router/selector.ts`
- `src/router/failover.ts`
- `src/router/health.ts`
- `src/router/circuit-breaker.ts`

### 4. Global Config and Secrets

Use a user-level config file such as:

- `~/.config/parachute-proxy/config.json`

Config should cover:

- default listen host and port
- provider enablement
- API keys or credential references
- default provider order
- model alias to provider/model mappings
- retry, timeout, and health-check thresholds
- logging verbosity

Recommended approach:

- parse config from JSON
- allow environment variables to override specific fields
- support credential references where possible instead of raw secrets
- validate config on startup with a schema library such as `zod`

Example config sections:

- `server`
- `routing`
- `providers.anthropic`
- `providers.vertex`
- `providers.bedrock`
- `models.claude-sonnet`

### 5. Observability

Minimum observability for v1:

- structured JSON logs
- request IDs and upstream provider tags
- counters for success, retry, failover, timeout, and circuit-open events
- counters for stream-started, stream-completed, and stream-aborted events
- optional `/health` and `/ready` endpoints
- optional `/metrics` endpoint if Prometheus format is worth the cost

Streaming-specific logging:

- log the provider selected for each proxied stream
- record whether a stream completed normally or ended due to upstream disconnect/error
- distinguish pre-response failures from mid-stream failures because failover behavior differs

## Provider Notes

### Anthropic

- easiest baseline provider because it is closest to the target request format
- should be implemented first to establish the shared provider contract

### Vertex AI

- likely needs model and auth translation that differs significantly from Anthropic
- should support service account or ADC-based auth where practical
- model naming and regional endpoint configuration should be explicit in config

### AWS Bedrock

- likely needs request signing and region-aware runtime calls
- should support profile-based auth or environment-based AWS credentials
- model ID mapping must be configurable, not hard-coded

## Recommended Project Structure

```text
plans/
src/
  api/
  config/
  http/
  providers/
    anthropic/
    vertex/
    bedrock/
  router/
  streaming/
  telemetry/
  types/
  main.ts
test/
scripts/
```

## Technical Decisions

### Runtime and Packaging

- use Bun as the primary runtime
- use Bun's bundling and native executable support for release artifacts
- keep dependencies small and compatible with Bun binary compilation

### Language and Tooling

- TypeScript only
- strict `tsconfig` from the start
- `eslint` and `prettier` or `biome` for consistency
- `zod` for config and payload validation
- `async-retry` for retry orchestration
- Bun test runner for unit and integration coverage unless a missing feature forces `vitest`
- one opt-in live integration test that exercises the real proxy against Anthropic with a real config path

### HTTP Server

- start with Bun's native HTTP server
- keep the route surface small: one main `POST /proxy` endpoint plus health/readiness endpoints
- keep request lifecycle concerns explicit in our own handler pipeline
- only switch to Fastify if Bun HTTP turns out to be awkward for Claude-compatible streaming behavior

### Reference Pattern

There is a relevant local reference in the `shortcut` repository:

- `shortcut/api/server-v1/src/routes/index.ts` shows Fastify route registration for `/api/proxy/*`
- `shortcut/api/server-v1/src/lib/proxy/secure-endpoint-handler.ts` shows how proxy handlers can share auth, validation, and streaming concerns cleanly

We should borrow the handler-composition ideas, but simplify this project to a single `/proxy` entrypoint and not pull in Fastify unless it solves a concrete problem.

## MVP: Initial Verification

The MVP is the smallest slice that proves the proxy works end-to-end. Everything else builds on top of this.

### What "done" looks like

```
$ bun run src/main.ts
[proxy] loaded config from ~/.config/parachute-proxy/config.json
[proxy] listening on http://localhost:3080

# In another terminal:
$ curl -X POST http://localhost:3080/proxy \
    -H "Content-Type: application/json" \
    -d '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"Say hello"}],"max_tokens":128,"stream":true}'

event: message_start
data: {"type":"message_start","message":{"id":"msg_...","type":"message",...}}

event: content_block_start
data: {"type":"content_block_start","index":0,...}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
...
event: message_stop
data: {"type":"message_stop"}
```

### MVP scope (Phases 0-3 combined)

| Layer            | What ships                                                    | What doesn't ship yet            |
|------------------|---------------------------------------------------------------|----------------------------------|
| Project skeleton | Bun + TS, strict tsconfig, biome, bun test                   | CI pipeline                      |
| Config           | JSON loader, zod schema, env overrides for keys               | Live reload, credential refs     |
| Server           | `POST /proxy`, `GET /health`                                  | `/metrics`, `/ready`             |
| Provider         | Anthropic adapter only (translate, stream, classify errors)   | Vertex, Bedrock                  |
| Router           | Single-provider selection, no failover                        | Circuit breaker, health probes   |
| Streaming        | SSE pass-through from Anthropic to client                     | Mid-stream failover              |
| Retry            | Bounded retry on 5xx/transport errors via `async-retry`       | Failover to secondary provider   |
| Observability    | Structured JSON logs, request IDs                             | Counters, Prometheus             |
| Tests            | 1 live e2e test (opt-in), unit tests for config + routing     | Mock provider integration tests  |

### MVP verification criteria

1. `bun run src/main.ts` starts the proxy from `~/.config/parachute-proxy/config.json`
2. `POST /proxy` with a Claude-compatible body returns a streaming SSE response from Anthropic
3. Non-streaming requests also return a JSON response correctly
4. Invalid requests return appropriate error responses (400, 401, etc.)
5. `GET /health` returns 200
6. `bun test` passes all unit tests
7. The opt-in live e2e test (`LIVE_TEST=1 bun test test/e2e/`) passes against real Anthropic

### MVP data flow (detailed)

```
                    ┌─────────────────────────────────────────┐
                    │              POST /proxy                 │
                    │                                         │
                    │  1. Parse JSON body                     │
                    │  2. Validate with zod                   │
                    │  3. Assign request ID                   │
                    │  4. Log: {reqId, model, stream}         │
                    └────────────────┬────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────┐
                    │           Router (MVP: trivial)          │
                    │                                         │
                    │  - look up model in config              │
                    │  - return primary provider (Anthropic)  │
                    └────────────────┬────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────┐
                    │        Anthropic Provider Adapter        │
                    │                                         │
                    │  translate():                           │
                    │    - map /proxy body → /v1/messages     │
                    │    - set Authorization header           │
                    │    - set anthropic-version header       │
                    │                                         │
                    │  stream():                              │
                    │    - fetch() to api.anthropic.com       │
                    │    - pipe SSE events back to client     │
                    │                                         │
                    │  classify(error):                       │
                    │    - 429 → throttled (retryable)        │
                    │    - 500/502/503 → server (retryable)   │
                    │    - 401/403 → auth (fatal)             │
                    │    - 400 → validation (fatal)           │
                    └────────────────┬────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────┐
                    │         Retry Layer (async-retry)        │
                    │                                         │
                    │  - max 2 retries for retryable errors   │
                    │  - exponential backoff                  │
                    │  - no retry on auth/validation errors   │
                    │  - no retry once stream bytes sent      │
                    └─────────────────────────────────────────┘
```

## Delivery Phases

### Phase 0: Live Test Anchor

- create one opt-in live integration test as the TDD anchor for the project
- start the real local proxy process using a real config path for credentials
- send one simple request through the proxy to Anthropic
- assert that the test receives a successful LLM response
- keep the test intentionally narrow: one request, one response, no failover coverage yet

Deliverable: a single "hello proxy world" test that hits the real proxy and Anthropic end to end

### Phase 1: Discovery

- confirm exactly which Claude Code request shape, headers, and streaming format must be supported through `POST /proxy`
- capture example successful request and streaming response flows
- define the minimum compatibility surface for v1
- inspect the `shortcut` proxy handlers for reusable patterns, not shared code

Deliverable: short compatibility spec in `plans/` or `docs/`

### Phase 2: Foundation

- initialize Bun + TypeScript project
- add linting, formatting, testing, and strict typing
- implement config loading and schema validation
- implement Bun HTTP server bootstrap and `POST /proxy`
- implement structured logging and health endpoints

Deliverable: proxy process boots from global config and exposes local status routes

### Phase 3: Anthropic Backend (completes MVP)

- implement Anthropic provider adapter
- proxy the first Claude-compatible request path end to end behind `POST /proxy`
- support streaming responses with event forwarding
- classify errors and wire baseline retry behavior with `async-retry`
- verify all MVP verification criteria pass

Deliverable: Claude Code works through the proxy against Anthropic only

### Phase 4: Health and Failover Core

- add provider health state tracking
- add circuit breaker behavior (CLOSED → OPEN → HALF-OPEN state machine)
- detect provider instability from `5xx` responses and mid-stream failures
- add fallback routing from Anthropic to secondary providers
- emit logs and counters for failover decisions

Deliverable: proxy survives upstream outages and reroutes according to policy

### Phase 5: Vertex Adapter

- implement Vertex request/response adapter
- support service account / ADC auth and regional model mapping
- verify streaming behavior and failure classification

Deliverable: Vertex can serve as primary or fallback provider

### Phase 6: Bedrock Adapter

- implement Bedrock adapter with SigV4 request signing
- support profile-based or environment-based AWS credentials
- verify model mapping, streaming behavior, and timeout handling

Deliverable: Bedrock can serve as primary or fallback provider

### Phase 7: Packaging and Release

- compile native binary with Bun
- produce startup examples and sample global config
- add smoke-test script for release verification

Deliverable: local installable binary plus setup documentation

## Testing Strategy

### Unit Tests

- config parsing and validation
- routing policy decisions
- circuit breaker state transitions
- provider error classification
- model mapping resolution

### Integration Tests

- local proxy to mocked provider servers
- streaming pass-through behavior
- retry and failover behavior under injected timeouts and `5xx` errors
- interrupted stream behavior where upstream closes after partial output
- config override behavior from environment variables
- one opt-in live test against Anthropic through the real local proxy

### Manual Verification

- point Claude Code at the local proxy
- simulate Anthropic outage and confirm fallback to Vertex or Bedrock
- simulate upstream `5xx` and mid-stream disconnect cases
- verify startup behavior with missing or invalid global credentials

## Risks

- Claude Code compatibility may depend on subtle headers or streaming semantics
- Vertex and Bedrock may not map cleanly to Anthropic-style request features
- Bun native binary support may impose constraints on dependencies or runtime behavior
- cross-provider failover may require careful handling when features are not equivalent
- mid-stream failover may not always be safe once response bytes have already been sent

## Open Questions

- What exact Claude Code payload and streaming contract must `POST /proxy` preserve?
- Is model fallback allowed across providers when capabilities differ slightly?
- Should the proxy preserve Anthropic request semantics exactly, or expose its own internal API too?
- Should config reload from `config.json` live, or is restart-on-change acceptable for v1?
- How much stream event normalization can we do without breaking Claude Code client expectations?

## Suggested First Milestone

The MVP (Phases 0-3) is the first milestone. See the **MVP: Initial Verification** section above for scope, data flow, and concrete verification criteria. It produces a working Anthropic-only proxy that Claude Code can use immediately, with the provider abstraction clean enough for Vertex and Bedrock to follow.
