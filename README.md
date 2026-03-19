```
    🪂
   /  \
  /    \
 /______\
    ||
    ||
   /  \
  /    \
```

# parachute-proxy

**For important things, it's good to have a backup.**

A local proxy that sits between Claude Code and your AI providers. If your primary provider goes down, parachute-proxy automatically fails over to your backup — so your coding session never hits the ground.

Supports **Anthropic**, **Vertex AI**, **AWS Bedrock**, and **OpenAI** as backends with automatic circuit-breaker failover.

---

## Quick Start

```bash
# Install Bun (if you don't have it)
curl -fsSL https://bun.sh/install | bash

# Clone and install
git clone <repo-url> && cd parachute-proxy
bun install

# Create your config
mkdir -p ~/.config/parachute-proxy
cp config.sample.json ~/.config/parachute-proxy/config.json

# Add your Anthropic API key (or set ANTHROPIC_API_KEY env var)
# Edit ~/.config/parachute-proxy/config.json and replace the placeholder key,
# or just export it:
export ANTHROPIC_API_KEY="sk-ant-YOUR-KEY-HERE"

# Start the proxy
bun run start
```

---

## Setup Guide

### 1. Setting Up Vertex AI as a Backup Provider

Vertex AI lets you access Claude models through Google Cloud, giving you an independent backend that stays up even if Anthropic's direct API is having issues.

#### Prerequisites

- A Google Cloud project with the **Vertex AI API** enabled
- A service account with the **Vertex AI User** role
- The service account's JSON key file

#### Step 1: Enable Vertex AI in Google Cloud

```bash
gcloud services enable aiplatform.googleapis.com --project=YOUR_PROJECT_ID
```

#### Step 2: Create a Service Account

```bash
# Create the service account
gcloud iam service-accounts create parachute-proxy \
  --display-name="Parachute Proxy" \
  --project=YOUR_PROJECT_ID

# Grant Vertex AI User role
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:parachute-proxy@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"

# Generate a JSON key
gcloud iam service-accounts keys create vertex-key.json \
  --iam-account=parachute-proxy@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

#### Step 3: Configure Authentication

Choose **one** of these methods:

**Option A — Environment variable (recommended):**

```bash
# Set the full JSON key as an env var
export GOOGLE_CREDENTIALS_JSON="$(cat vertex-key.json)"
```

Add this to your shell profile (`~/.zshrc`, `~/.bashrc`) to persist it.

**Option B — gcloud ADC:**

```bash
gcloud auth application-default login
```

The proxy will automatically use ADC if no `GOOGLE_CREDENTIALS_JSON` is set.

#### Step 4: Update Your Config

Edit `~/.config/parachute-proxy/config.json`:

```json
{
  "providers": {
    "anthropic": {
      "enabled": true,
      "apiKey": "sk-ant-YOUR-ANTHROPIC-KEY"
    },
    "vertex": {
      "enabled": true,
      "projectId": "YOUR_PROJECT_ID",
      "region": "us-east5"
    }
  },
  "routing": {
    "providerOrder": ["anthropic", "vertex"]
  }
}
```

This routes requests to Anthropic first, failing over to Vertex if Anthropic is down.

> **Tip:** You can also set `VERTEX_PROJECT_ID` as an env var instead of putting it in the config file. This auto-enables the Vertex provider.

#### Step 5: Verify Vertex Works

```bash
# Start the proxy
bun run start

# In another terminal, force a request through Vertex
curl -s http://localhost:3080/v1/messages?provider=vertex \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 64,
    "messages": [{"role": "user", "content": "Say hello"}]
  }'
```

You should get a JSON response back from Claude via Vertex.

---

### 2. Pointing Claude Code at the Proxy

#### Step 1: Start the Proxy

```bash
cd /path/to/parachute-proxy
bun run start
# => {"ts":"...","level":"info","msg":"Proxy listening","url":"http://127.0.0.1:3080"}
```

#### Step 2: Set `ANTHROPIC_BASE_URL`

Tell Claude Code to send requests through the proxy:

```bash
export ANTHROPIC_BASE_URL="http://localhost:3080"
```

Add this to your shell profile (`~/.zshrc`, `~/.bashrc`) to make it permanent.

#### Step 3: Use Claude Code Normally

```bash
claude
```

That's it. Claude Code sends all requests to `http://localhost:3080/v1/messages`, and the proxy routes them to your configured providers with automatic failover.

#### Verify It's Working

Check the proxy's health endpoint:

```bash
curl -s http://localhost:3080/health
```

Watch the proxy logs in the terminal where you started it — you'll see requests flowing through as structured JSON logs.

> **Tip:** You can also put env vars in a `.env` file in the project root. Bun auto-loads it on startup.

---

## Configuration Reference

### Config File Location

| Method | Path |
|--------|------|
| Default | `~/.config/parachute-proxy/config.json` |
| Override | Set `CONFIG_PATH=/path/to/config.json` |

### Environment Variable Overrides

These override values in the config file:

| Variable | Effect |
|----------|--------|
| `ANTHROPIC_API_KEY` | Sets Anthropic API key |
| `VERTEX_PROJECT_ID` | Sets Vertex project ID and auto-enables Vertex |
| `GOOGLE_CREDENTIALS_JSON` | Service account JSON for Vertex auth |
| `OPENAI_API_KEY` | Sets OpenAI key and auto-enables OpenAI |
| `PROVIDER_ORDER` | Comma-separated failover order, e.g. `"anthropic,vertex"` |
| `PROXY_PORT` | Override the server port (default: `3080`) |
| `CONFIG_PATH` | Override the config file path |

### Full Config Example

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 3080
  },
  "providers": {
    "anthropic": {
      "enabled": true,
      "apiKey": "sk-ant-..."
    },
    "vertex": {
      "enabled": true,
      "region": "us-east5",
      "projectId": "my-gcp-project"
    },
    "bedrock": {
      "enabled": false,
      "region": "us-east-1",
      "profile": "default"
    },
    "openai": {
      "enabled": false,
      "apiKey": "sk-...",
      "modelMap": {
        "claude-opus-4-6": "gpt-5.4",
        "claude-sonnet-4-20250514": "gpt-4.1"
      }
    }
  },
  "routing": {
    "providerOrder": ["anthropic", "vertex", "bedrock"]
  },
  "circuitBreaker": {
    "failureThreshold": 5,
    "failureWindowMs": 300000,
    "cooldownMs": 600000
  },
  "retry": {
    "maxRetries": 1,
    "minTimeoutMs": 500,
    "maxTimeoutMs": 5000,
    "requestTimeoutMs": 120000
  }
}
```

---

## How It Works

```
Claude Code
  │
  │  ANTHROPIC_BASE_URL="http://localhost:3080"
  ▼
┌─────────────────────────┐
│    parachute-proxy      │
│                         │
│  ┌───────────────────┐  │
│  │ Circuit Breaker   │  │
│  │ + Retry Logic     │  │
│  └───────┬───────────┘  │
│          │              │
│  ┌───────▼───────────┐  │
│  │ Provider Router   │  │
│  │ (failover chain)  │  │
│  └───┬───┬───┬───┬───┘  │
└──────┼───┼───┼───┼──────┘
       │   │   │   │
       ▼   ▼   ▼   ▼
      A   V   B   O
      n   e   e   p
      t   r   d   e
      h   t   r   n
      r   e   o   A
      o   x   c   I
      p       k
      i
      c
```

Requests flow through your configured `providerOrder`. If the first provider fails, the circuit breaker trips and requests automatically route to the next healthy provider.

---

## Scripts

| Command | Description |
|---------|-------------|
| `bun run start` | Start the proxy |
| `bun run dev` | Start with auto-reload on file changes |
| `bun run build` | Compile to a standalone binary at `dist/parachute-proxy` |
| `bun test` | Run tests |
| `bun run lint` | Check code with Biome |
| `bun run format` | Auto-format code |
