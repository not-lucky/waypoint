# Waypoint: Core Configuration & Key Registry

Waypoint is a lightweight, opinionated local proxy and gateway designed for developer-first workflows. It provides a single entry point for sharing a pool of API keys across multiple LLM providers with automatic load distribution, cooldown circuit breaking, and failure recovery.

> [!WARNING]
> WIP — do not use in production.

---

## Implementation Status

| Component | Status | Notes |
|---|---|---|
| Config loader & hot-reload | ✅ Done | YAML parsing, env var interpolation, file watcher |
| Config validation (Zod) | ✅ Done | Fail-fast on startup, degraded-mode key warnings |
| KeyObject entity | ✅ Done | Tracks availability, cooldown, exhaustion state |
| KeyRegistry — round-robin | ✅ Done | Sequential rotation across active keys |
| KeyRegistry — fill-first | ✅ Done | Drains first available key before failing over |
| Circuit breaking & cooldown | ✅ Done | 429 exponential backoff, 402/403 permanent exhaustion |
| ProviderFactory | ✅ Done | Adapter registration/retrieval scaffold |
| HTTP server + `/health` | ✅ Done | Express server with graceful shutdown |
| ESLint (airbnb-base) | ✅ Done | Enforced across all source files |
| Request routing / proxying | ✅ Done | Ingress controllers translate to unified internal schema, route, and map back responses |
| Model aliasing / fallback routing | ✅ Done | Resolves prefixes/aliases and automates failover to fallback models on exhaustion |
| Unified Streaming Support | ✅ Done | Iterates generator, flags success after first chunk, maps SSE formats (OpenAI / Anthropic), aborts early |
| Provider adapters (Gemini, Anthropic, OpenAI) | ✅ Done | Implemented with Vercel AI SDK, utilizing Modern JS patterns (pure functions, immutability) |
| Client authentication | ✅ Done | Bearer token validation middleware |
| Per-client rate limiting | ✅ Done | In-memory sliding window rate limiter |
| CORS & payload limits | ✅ Done | Allowed origins list and dynamic request body size constraints |
| Logging (file + console) | ⬜ Planned | Config schema present; logger not wired up |

---

## Key Features (implemented)

### 1. Robust Configuration & Hot-Reloading
- Reads `config/config.yaml` and resolves `${ENV_VAR}` references at startup.
- Watches the config file for changes and reloads key pools automatically, without restarting the process.
- Validates the full config structure with Zod on every load — fails fast on structural errors.
- Starts in **degraded mode** if only some keys in a provider pool are missing; aborts if *all* keys for a provider are absent.

### 2. In-Memory API Key Pool Management
- Maintains a per-provider pool of `KeyObject` instances tracking each key's state.
- Two routing strategies selectable via config:
  - **`round-robin`** *(default)*: Distributes requests evenly across all active keys.
  - **`fill-first`**: Always uses the first available key, falling over only when it becomes unavailable — optimises for prompt cache locality.
- **Circuit breaking** on upstream errors:
  - **429 (Rate Limited)**: Exponential backoff cooldown (`base_seconds × 2ⁿ`, capped at `max_seconds`), then auto-reactivation.
  - **402 / 403 (Quota / Forbidden)**: Permanently marks the key as exhausted.
  - **Other errors**: Brief transient cooldown, key remains inactive for the duration.
- `flagSuccess` resets consecutive failure counters and reactivates a key.

### 3. Unified Request Routing & Protocol Translation
- Supports both OpenAI chat completions and Anthropic Messages ingress APIs.
- Normalizes incoming requests, maps model names/aliases, and routes them to the correct backend provider adapter.
- Normalizes response shapes, mapping thinking/reasoning blocks and usage data back to the protocol expected by the client.

### 4. Unified Streaming (SSE)
- Streams response chunks from Google Gemini, Anthropic Claude, and OpenAI models.
- Provides unified retry/fallback behavior during stream initialization.
- Converts stream chunks into the correct SSE protocol events (OpenAI or Anthropic Messages SSE).
- Intercepts connection close events to abort active upstream requests, preserving API key quota.

### 5. ProviderFactory
- A simple adapter registry — `register(name, adapter)` / `get(name)` — wired up with provider-specific adapters.

### 6. HTTP Server
- Express server that binds to `config.gateway.port`.
- Exposes a `GET /health` endpoint returning `{ "status": "ok" }`.

### 7. Client Authentication & Authorization
- Secures standard endpoints with API token validation.
- Validates the incoming header `Authorization: Bearer <token>` and maps the request to a configured client profile.

### 8. Sliding-Window Rate Limiting
- Evaluates per-client API limits dynamically based on the matched client token.
- Uses an in-memory sliding window to track request timestamps, returning `429 Rate Limit Exceeded` when limits are reached.

### 9. CORS & Dynamic Request Body Size Constraints
- Dynamically configures allowed origins based on CORS configuration.
- Enforces request body size limits dynamically (e.g. `'10mb'`), returning a `413 Payload Too Large` to prevent oversized request exploits.

---

## Getting Started

### Prerequisites
- Node.js v18+
- pnpm (or npm)

### Installation
```bash
pnpm install
```

### Running Waypoint
Development mode (file-watch auto-restart):
```bash
pnpm dev
```

### Production mode
```bash
pnpm start
```

### Running Tests
202 unit/integration tests across 21 test files, run via **Vitest**:
```bash
pnpm test
```

### Linting
```bash
pnpm lint
```

---

## Configuration Guide

Waypoint reads configuration from `config/config.yaml`. Environment variables inside the YAML (formatted as `${ENV_VAR}`) are interpolated at startup and on every hot-reload.

### Example Configuration
```yaml
gateway:
  port: 20128
  global_retry_limit: 3
  max_payload_size: "10mb" # Maximum allowed payload size for requests
  cooldown:
    base_seconds: 30
    max_seconds: 3600
  routing:
    strategy: "round-robin" # "round-robin" or "fill-first"
  cors:
    allowed_origins:
      - "*"

logging:
  enable_console: true
  enable_file: true
  file_path: "./logs/waypoint.log"
  format: "json"

clients:
  - name: "open-webui"
    token: "${OPEN_WEBUI_TOKEN}"
    rate_limit:
      window_ms: 60000
      max: 100
  - name: "codex-agent"
    token: "${CODEX_AGENT_TOKEN}"
    rate_limit:
      window_ms: 60000
      max: 30

providers:
  gemini:
    keys:
      - "${GEMINI_API_KEY_1}"
      - "${GEMINI_API_KEY_2}"
    models:
      - id: "gemini-2.5-pro"
        aliases: ["gemini-pro"]
        actual_model_id: "gemini-2.5-pro-preview-05-06"
        thinking_supported: true
        default_thinking_budget: 2048
        fallback_model: "openai/gpt-4o"
```

### Fail-Fast & Degraded-Mode Policy

> [!WARNING]
> **Fail-fast**: Missing client tokens, invalid numeric fields, or structural config errors will log a fatal error and abort startup immediately.
>
> **Degraded mode**: If some (but not all) keys in a provider's `keys:` array resolve to empty strings, Waypoint logs a warning and starts with only the valid keys. If *all* keys for a configured provider are missing, startup is aborted.

---

## API Endpoints

### `GET /health`
Returns gateway health status.

**Response**:
```json
{ "status": "ok" }
```
