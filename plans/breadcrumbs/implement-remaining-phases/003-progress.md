# Progress 003

## Done
- **Mid-stream failure detection**: Wrapped streaming responses in a monitored `ReadableStream` (`createMonitoredStream`) that catches upstream errors after bytes are sent, logs them, and records failures in the circuit breaker
- **AWS profile-based credentials**: Bedrock adapter now reads `~/.aws/credentials` INI file with support for named profiles (config `profile` field or `AWS_PROFILE` env var, falling back to `default`)
- **Vertex ADC token resolution**: Vertex adapter uses `gcloud auth application-default print-access-token` when no `apiKey` is configured, with 50-minute token caching
- **Config schema**: Added `profile` field to `providerConfigSchema`
- **Unit tests**: 9 new tests for AWS credentials INI parsing (`parseAwsCredentials`), stream monitoring integration test, updated bedrock adapter test for credential isolation
- **Test counts**: 97 pass, 9 skip, 0 fail across 14 files (up from 87/13)
- Updated `config.sample.json` with Vertex `apiKey` hint and Bedrock `profile` field

## Remaining
- Vertex/Bedrock live testing (requires credentials not available in test environment)
- Mid-stream failure detection only works when stream `read()` errors — HTTP-level connection resets may appear as clean stream ends (Bun limitation)
- No service account JWT signing for Vertex (relies on gcloud CLI for ADC)

## Context
- `parseAwsCredentials` is exported from bedrock adapter for direct unit testing
- `resolveAdcToken` and `resetAdcTokenCache` exported from vertex adapter for testing
- Stream monitoring records success on 200 response, then records failure only if `reader.read()` throws during streaming
- Bedrock test "no credentials" now isolates env vars with `AWS_SHARED_CREDENTIALS_FILE=/nonexistent/path` to prevent host credentials leaking
