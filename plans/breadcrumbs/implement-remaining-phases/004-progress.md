# Progress 004

## Done

- **Vertex service account JWT signing**: Vertex adapter now supports `GOOGLE_CREDENTIALS_JSON` env var — parses service account JSON, creates RS256-signed JWT assertion, exchanges it for an access token via Google OAuth2 token endpoint, with 50-minute caching
- **Auth resolution order**: Vertex adapter tries in order: (1) explicit `apiKey` from config, (2) service account JWT from `GOOGLE_CREDENTIALS_JSON`, (3) gcloud CLI ADC fallback
- **Unit tests**: 5 new tests for JWT assertion (structure, header, payload claims, RSA-SHA256 signature verification, resolveAccessToken null-safety)
- **All live e2e tests verified**: `LIVE_TEST=1 bun test test/e2e/` — 5 pass (4 live proxy + 1 Claude Code round-trip)
- **All unit tests pass**: 102 pass, 9 skip, 0 fail across 14 files
- **Binary compilation verified**: `bun build --compile` produces working binary

## Remaining

- Vertex/Bedrock live provider testing (Vertex needs valid `GOOGLE_CREDENTIALS_JSON` with Vertex AI API access; Bedrock needs AWS credentials with Bedrock access)
- Mid-stream failure detection only catches `reader.read()` errors — HTTP connection resets may appear as clean stream ends (Bun runtime limitation)

## Context

- `createJwtAssertion` exported from vertex adapter for direct unit testing
- Token exchange uses synchronous `curl` via `spawnSync` since `translate()` is synchronous
- `resolveAdcToken` / `resetAdcTokenCache` renamed to `resolveAccessToken` / `resetTokenCache`