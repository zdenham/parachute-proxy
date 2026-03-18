# Compatibility Spec: POST /proxy

## Overview

The proxy exposes a single `POST /proxy` endpoint that accepts the same request shape as the Anthropic Messages API (`POST /v1/messages`) and returns the same response format (streaming SSE or JSON).

Claude Code sends requests to this endpoint instead of directly to `api.anthropic.com`.

## Request Shape

### Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Content-Type` | Yes | Must be `application/json` |
| `anthropic-version` | No | Forwarded to upstream if present (e.g., `2023-06-01`) |
| `x-request-id` | No | If provided, used as the request ID; otherwise generated |

**Note**: The proxy does NOT require an `Authorization` or `x-api-key` header from the client. API keys are configured server-side in the proxy config. Claude Code should be configured with a dummy key or no key.

### Body (JSON)

The request body matches the [Anthropic Messages API](https://docs.anthropic.com/en/api/messages):

```json
{
  "model": "claude-sonnet-4-20250514",
  "messages": [
    { "role": "user", "content": "Say hello" }
  ],
  "max_tokens": 1024,
  "stream": true,
  "system": "You are a helpful assistant.",
  "temperature": 0.7,
  "top_p": 0.9,
  "top_k": 40,
  "stop_sequences": ["\n\nHuman:"],
  "metadata": { "user_id": "user-123" }
}
```

Required fields: `model`, `messages`, `max_tokens`
Optional fields: `stream`, `system`, `temperature`, `top_p`, `top_k`, `stop_sequences`, `metadata`, `tools`, `tool_choice`

The `stream` field defaults to `false` if omitted.

### Message Content Types

Messages use the Anthropic content block format:

- **String content**: `{ "role": "user", "content": "Hello" }`
- **Array content**: `{ "role": "user", "content": [{ "type": "text", "text": "Hello" }] }`
- **Tool use**: `{ "type": "tool_use", "id": "...", "name": "...", "input": {...} }`
- **Tool result**: `{ "type": "tool_result", "tool_use_id": "...", "content": "..." }`

## Response: Non-Streaming (stream: false)

### Headers

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `x-request-id` | The request ID |

### Body

Standard Anthropic Messages response:

```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Hello! How can I help you today?" }
  ],
  "model": "claude-sonnet-4-20250514",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 12,
    "output_tokens": 15
  }
}
```

## Response: Streaming (stream: true)

### Headers

| Header | Value |
|--------|-------|
| `Content-Type` | `text/event-stream` |
| `Cache-Control` | `no-cache` |
| `Connection` | `keep-alive` |
| `x-request-id` | The request ID |

### SSE Event Sequence

Events are forwarded verbatim from the upstream provider. The standard sequence:

1. `message_start` — contains the message object (without content)
2. `content_block_start` — signals start of a content block
3. `content_block_delta` — incremental text or tool input deltas
4. `content_block_stop` — signals end of a content block
5. `message_delta` — final message-level metadata (stop_reason, usage)
6. `message_stop` — signals end of the message

Each event follows SSE format:
```
event: message_start
data: {"type":"message_start","message":{...}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

```

## Error Responses

Errors returned as JSON with appropriate HTTP status codes:

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "max_tokens is required"
  }
}
```

| Status | Error Type | Description |
|--------|-----------|-------------|
| 400 | `invalid_request_error` | Bad request body or missing fields |
| 401 | `authentication_error` | Missing or invalid API key in config |
| 429 | `rate_limit_error` | Upstream rate limited |
| 500 | `api_error` | Internal proxy error |
| 502 | `api_error` | Upstream returned an error |
| 503 | `overloaded_error` | Upstream overloaded or unavailable |

## Proxy-Specific Behavior

1. **API key injection**: The proxy adds the `x-api-key` header from its config before forwarding upstream
2. **Request ID**: Generated if not provided; included in all logs and response headers
3. **SSE pass-through**: Streaming events are piped from upstream with no transformation
4. **Model mapping**: The `model` field is used as-is for Anthropic; other providers may remap
5. **Retry**: Retryable errors (429, 5xx) are retried up to 2 times with exponential backoff before the response is sent to the client. Once streaming bytes are sent, no retry is attempted.
