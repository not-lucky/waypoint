# Waypoint: Unified LLM Proxy & Gateway

Waypoint is a lightweight, opinionated, developer-first local proxy and gateway. It provides a single entry point for sharing a pool of API keys across multiple LLM providers (Google Gemini, Anthropic Claude, OpenAI, OpenRouter, and custom OpenAI/Anthropic-compatible services) with automatic load distribution, cooldown circuit breaking, and dynamic failure recovery.

Waypoint accepts OpenAI- and Anthropic-compatible HTTP APIs, preserves provider-specific request fields, and supports OpenAI-style tool/function calling, multimodal text-plus-image messages, reasoning/thinking normalization, SSE streaming, and dry-run inspection.

---

## System Architecture

Waypoint enforces strict **Separation of Concerns** using a layered Clean Architecture model. Inbound client payloads are authenticated, validated, and normalized before being passed to key registries and provider adapters.

```text
               ┌─────────────────────────────────────────────────┐
               │              Inbound HTTP Requests              │
               │     (e.g., OpenAI, Anthropic, Gemini client)    │
               └────────────────────────┬────────────────────────┘
                                         │
                                         ▼
               ┌─────────────────────────────────────────────────┐
               │          Ingress Validation & Security          │
               │  - Client Authentication - Token Rate Limiter   │
               │  - Zod/Payload Validator - Custom Header Parser │
               │  - Tool/Multimodal Schema - Provider field passthrough │
               └────────────────────────┬────────────────────────┘
                                         │
                                         ▼
               ┌─────────────────────────────────────────────────┐
               │              Protocol Controllers               │
               │  - Translate Incoming Protocol to Unified Model │
               │  - OpenAI Chat Completions - Anthropic Messages │
               │  - Standardize Outputs/Error Schemas for Client │
               └────────────────────────┬────────────────────────┘
                                         │
                                         ▼
               ┌─────────────────────────────────────────────────┐
               │              Unified Service Layer              │
               │  - Retry Loop Engine    - Failover Director     │
               │  - Strategy Selector                            │
               └────────────────────────┬────────────────────────┘
                                         │
                                         ▼
               ┌─────────────────────────────────────────────────┐
               │            Key Registry Service                 │
               │  - Round-Robin Pointer   - Cooldown Circuit     │
               │  - Exhaustion Tracking                          │
               └────────────────────────┬────────────────────────┘
                                         │
                                         ▼
               ┌─────────────────────────────────────────────────┐
               │            Provider Factory & Adapters          │
               │  - Abstract BaseProvider Interface              │
               │  - Provider Adapters (direct HTTP integrations) │
               │  - Mock Strategy Registry (for unit tests)      │
               └─────────────────────────────────────────────────┘
```

---

## Core Features

### 1. Robust Configuration Management
- **Environment Interpolation**: Resolves `${ENV_VAR}` tokens in `config/config.yaml` during boot.
- **Fail-Fast Structural Zod Validation**: Validates the entire configuration structure on load, stopping startup instantly on format errors to prevent silent configuration failures.

### 2. API Key Pool Management & Circuit Breaking
- Maintains stateful `KeyObject` telemetry in-memory for each provider key pool.
- **Map-Backed Key Lookup**: Automatically switches from an O(n) array search to an O(1) Map-backed lookup for key pools containing 10 or more keys, optimizing performance for large-scale rotations.
- **Routing Strategies**:
  - `round-robin`: Rotates keys sequentially per request to balance load evenly across active keys.
  - `fill-first`: Uses the first available key and fails over only when exhausted, optimizing for upstream **prompt cache locality**.
- **Circuit Breaking & HTTP-Status Cooldowns**:
  Instead of permanently exhausting keys on every error, Waypoint uses an HTTP-status-driven lifecycle. 401 / 403 retire the key, 402 / 408 / 429 / 5xx apply a cooldown (429 uses exponential backoff), and other 4xx or transport errors leave the key state unchanged. Keys auto-reactivate when the cooldown timer expires. For details, see the [Key Lifecycle & Cooldown Policy](#-key-lifecycle--cooldown-policy) section below.

### 3. Unified Reasoning Model
- Normalizes reasoning/thinking efforts using standard levels (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`).
- Maps levels dynamically to adapter specifications:
  - **OpenAI/OpenRouter**: Translates to `reasoning_effort`, sets `include_reasoning` when enabled, and normalizes upstream reasoning payloads into `reasoning_content` without duplicating OpenRouter's mirrored `reasoning` / `reasoning_details` fields.
  - **Anthropic (Claude 3.7+)**: Interpolates extended thinking `budget_tokens`.
  - **Gemini (Flash-Lite / Pro)**: Translates to model-specific native thinking levels (`minimal`, `low`, `medium`, `high`).

### 4. OpenAI-Compatible Tool Calling & Multimodal Ingress
- Validates and forwards OpenAI-style `tools`, `tool_choice`, assistant `tool_calls`, and `tool` role result messages through the OpenAI ingress.
- Accepts `system`/`developer` instruction roles, `user`, `assistant`, and `tool` messages at the gateway boundary.
- Supports message `content` as either a string or an array of content blocks, including `{ type: "text", text: "..." }` and `{ type: "image_url", image_url: { url: "..." } }`.
- Preserves unknown provider-specific fields with Zod `.passthrough()` while still validating critical routing, streaming, reasoning, and tool-calling fields.
- Merges streaming tool-call deltas by index and accumulates final tool calls into normalized stream summaries.

### 5. Settings Precedence Hierarchy
Waypoint resolves parameters (e.g., `temperature`, `maxTokens`, `max_tokens`, `max_completion_tokens`, `reasoningEffort`) using a deterministic hierarchy:
1. **Flat Model Defaults**: Settings configured directly at the root of a model's YAML config block.
2. **Client Payload**: Body parameters supplied in the incoming client HTTP call.
3. **Configuration Overrides**: Values inside the model's `overrides` block, acting as a locked policy that client options cannot bypass.

For OpenAI-compatible requests, `max_tokens` takes precedence when present; `max_completion_tokens` is accepted as the alternate client field when `max_tokens` is absent.

### 6. Automated Fallback Routing
- If all API keys in a provider pool are rate-limited or exhausted for a given model, Waypoint automatically failovers to a designated `fallbackModel` (e.g., from Gemini to OpenAI) to maintain request reliability.

### 7. Logging & Telemetry Auditing
- **LogTape Integration**: Integrated via `@logtape/logtape` and `@logtape/file` to support text-based developer formats or JSON telemetry streams.
- **Per-Request Auditing**: If `logRequests` is enabled, captures every phase of the request/response lifecycle under `requestLogPath` in separate files:
  - `01_client_request.json`: Incoming HTTP client request headers (redacted) and body.
  - `02_provider_request.json`: Payload translated and sent to the upstream provider.
  - `03_provider_response.json`: Raw response received from the upstream provider.
  - `04_client_response.json`: Final unified payload sent to the client.
  - `05_event_stream.jsonl`: Complete chunk-by-chunk stream logs for Server-Sent Events (SSE).

### 8. Core Gateway Operations
- **OpenAI-compatible endpoints**: `GET /openai/v1/models` and `POST /openai/v1/chat/completions` are also mounted at `/openai/models` and `/openai/chat/completions`.
- **Anthropic-compatible endpoints**: `GET /anthropic/v1/models` and `POST /anthropic/v1/messages` are also mounted at `/anthropic/models` and `/anthropic/messages`.
- **SSE streaming**: `stream: true` returns OpenAI-style `chat.completion.chunk` events for OpenAI ingress and Anthropic Messages-style SSE events for Anthropic ingress.
- Secure endpoint authentication with bearer token mappings (`Authorization: Bearer <token>`).
- Client-level sliding window rate limiting.
- Ingress payload size constraints and CORS controls.
- **Health endpoint** (`GET /health`): requires authentication; returns `status` (`ok` or `degraded`), `uptimeSeconds`, per-provider key pool stats (`providers`) including provider-level status, an aggregate `keyPool` summary across all pools, and routing state (`routing`).
- **Metrics endpoint** (`GET /metrics`): requires authentication; returns Prometheus-compatible text output tracking request count (by provider, model, and status code), request latency histograms, key pool gauges (active/cooling/exhausted), and cooldown activation counters.
- **Dry-run endpoints**: mirror the live OpenAI and Anthropic routes under `/dryrun/openai/*` and `/dryrun/anthropic/*`. Requests are validated and logged but never sent upstream; the response includes `{ dryRun: true, ... }`. Requires `logging.logRequests: true` in config.

### 9. Error Responses (v1)

All client-visible failures use a single JSON envelope under an `error` object. Raw upstream response bodies are **never** returned as the root HTTP body. For the complete envelope structure, error codes, status forwarding, and streaming behaviors, see the [Client Error API Contract](#-client-error-api-contract) section below.

### 10. Performance & Allocation Optimizations
Waypoint incorporates extensive performance enhancements specifically tailored for high-throughput, low-latency sidecar deployments:
- **Cached Settings Normalization**: Uses a `WeakMap` to cache compiled model configs and settings overrides, avoiding repeated normalization and `Object.entries` object allocations on every request.
- **Circular Buffer Rate Limiting**: Employs a Symbol-indexed head pointer on sliding-window arrays to perform in-place pruning and compaction. This avoids high-overhead array slicing/splicing shifts, minimizing memory/GC pressure.
- **Loop-based Stream Accumulation**: Replaces array flat-mapping with structured loops when constructing chunked responses, reducing stream-processing memory allocations by up to 81%.
- **Syscall Minimization**: Passes a single cached `now` timestamp through rotation iteration paths, preventing redundant system-level clock queries (`Date.now()`).

---

## Key Lifecycle & Cooldown Policy

Waypoint manages a pool of upstream API keys per provider. When an upstream request fails, the gateway decides whether to permanently exhaust a key, apply a cooldown, or take no key action. Policy decisions are driven by the upstream's **raw HTTP status code** plus the `Retry-After` header — no per-error-code classification is performed.

### Core Rule
- `KeyObject.exhausted = true` only when the upstream returns **HTTP 401** or **HTTP 403**. These indicate the credential is bad or the account is denied; further attempts with the same key cannot succeed.
- All other status codes leave the credential potentially valid. The gateway applies a cooldown (the key auto-reactivates when the timer fires) or takes no action at all.

### Lifecycle Policy

| Upstream status | Key action | Cooldown duration |
|-----------------|-----------|-------------------|
| **401** | `retire` (`exhausted = true`) | none, never reactivated |
| **403** | `retire` (`exhausted = true`) | none, never reactivated |
| **402** | `cooldown` | `Retry-After` if present, otherwise the default (`gateway.cooldown.serverSeconds` is the closest analog; see `resolveCooldownSeconds` in `src/errors/policy.js`) |
| **408** | `cooldown` | same as 402 |
| **429** | `cooldown` | `Retry-After` if present, otherwise exponential: `baseSeconds * 2^consecutiveFailures`, capped at `maxSeconds` |
| **5xx** (500 / 502 / 503 / 504) | `cooldown` | `Retry-After` if present, otherwise `gateway.cooldown.serverSeconds` (default 60s) |
| **Other 4xx** (400, 404, 422, 451, …) | `none` | no key-state change — the request was wrong, not the key |
| **No status** (transport failure) | `none` | no key-state change — the request did not reach the provider |

### Configuration
The `gateway.cooldown` block accepts only three knobs:

```yaml
gateway:
  cooldown:
    baseSeconds: 30      # 429 exponential backoff base
    maxSeconds: 3600     # 429 exponential backoff cap (default 1 hour)
    serverSeconds: 60    # 5xx default cooldown when Retry-After is absent
```

All three are optional. See `config.example.yaml` for the full annotated example.

### Why No Per-Code Classification?
Earlier versions of Waypoint classified upstream errors into a T0–T5 tier system (e.g. `daily_tokens_exceeded` → T1, `rate_reduction_required` → T4b). The classifier required per-provider keyword matching, which:

- Duplicated logic that providers already maintain on their end.
- Made it hard to support new providers (every new error code required a code change).
- Hid the upstream's own message and code from the client, even when the client could act on it directly.

The new policy is a thin layer over the upstream's HTTP status. The upstream's exact `code`, `type`, and `message` are surfaced to the client verbatim (see [Cross-Protocol Error Mapping](#-cross-protocol-error-mapping)). Operators who want different behavior can plug in a custom client envelope without touching the key lifecycle.

### Retries
`isRetryable(statusCode)` (in `src/errors/policy.js`) returns `true` for 401, 403, 402, 408, 429, 5xx, and undefined (transport). The retry loop rotates to a different key when one is available; a 401 on the first key simply moves on to the second.

### Gateway Misconfiguration (No Key Fault)
- **`no_api_key`**: The orchestrator never calls `flagFailure` when the gateway itself failed to send an `Authorization` header. This indicates a gateway config bug, not an unhealthy credential.
- **`poolUnavailable`**: Pool-level error surfaced when no upstream call occurred (every key in the pool is in cooldown). Not a per-key lifecycle event.

---

## Client Error API Contract

Every client-visible failure uses a single JSON envelope under an `error` object. Raw upstream response bodies are **never** returned as the root HTTP body. Upstream debugging detail is retained in server-side logs only (with redaction).

### Error Sources

| Source | When | `provider` field |
|--------|------|------------------|
| **Gateway** | No upstream call — auth, validation, payload limits, dry-run guard, unhandled exceptions | Omitted |
| **Pool** | No upstream call — all keys for a provider are in cooldown | Required |
| **Upstream** | A provider request was attempted and failed | Required |

### Response Envelope Structure

```json
{
  "error": {
    "code": "rate_limit_exceeded",
    "type": "rate_limit_error",
    "message": "Rate limit exceeded.",
    "httpStatus": 429,
    "provider": "openai",
    "retryAfterSeconds": 30
  }
}
```

### Field Rules

| Field | Required | Notes |
|-------|----------|-------|
| `code` | Yes | The upstream's own error code, copied verbatim. If the upstream supplied no code, this is the literal string `upstream_error`. |
| `message` | Yes | The upstream's own error message, copied verbatim. |
| `httpStatus` | Yes | HTTP status returned to the client. For upstream errors this is the upstream's status; for transport failures (no status received) it is 502. |
| `type` | Upstream only | Provider-style category string from the upstream body (e.g. `rate_limit_error`, `authentication_error`); omitted for gateway and pool errors. |
| `upstreamCode` | Upstream only | Always the raw upstream `code`, preserved unchanged. This is the canonical field for clients that want to branch on the upstream's own machine identifier without ambiguity. |
| `provider` | Upstream + pool | Provider name (e.g. `openai`, `anthropic`, `gemini`); omitted for pure gateway faults |
| `retryAfterSeconds` | When relevant | Seconds until retry is advisable; also sets the `Retry-After` response header |
| `details` | Gateway validation only | Optional array of field-level validation issues (gateway extension) |

### Security Rules
- Never replace the entire response body with a raw upstream payload.
- Do not expose unredacted upstream trace tokens, account IDs, or internal policy details at the response root. Full upstream details are retained in server-side logs with redaction.

### Cross-Protocol Error Mapping

Waypoint accepts OpenAI- and Anthropic-shape ingress and routes to OpenAI-compatible, native Anthropic, and Gemini upstreams. Each upstream speaks a slightly different error envelope:

- **OpenAI-compatible** — `{ error: { message, type, code } }`
- **Anthropic** — `{ type: "error", error: { type, message } }`
- **Gemini** — `{ error: { code, message, status } }`

The gateway does not translate codes between protocols. Instead, it preserves the raw upstream code and projects the error into the ingress protocol's native envelope via `translateError` (`src/transforms/index.js`):

```
upstreamFormat × ingressFormat ∈ {openai, anthropic, gemini} × {openai, anthropic}
```

The hub format is OpenAI. The 3 × 3 matrix projects every upstream error into the matching ingress shape, always carrying:

- `code` — the upstream's own code (or `upstream_error` when absent)
- `upstreamCode` — the same value as `code`, but a stable named field for clients that want the raw provider identifier regardless of the ingress protocol
- `message` — the upstream's own message, verbatim
- `type` — the upstream's own type, with sensible defaults per ingress format
- `provider` — which upstream produced the error
- `upstreamBody` — the full parsed body, for clients that need every field
- `retryAfterSeconds` — parsed from `Retry-After` when the upstream sent one
- `statusCode` — the upstream's HTTP status

The mapping is unit-tested under `test/transforms/translateError.test.js` (all 9 cells).

### Streaming Errors
Supported streaming providers include OpenAI-compatible, Anthropic, and Gemini. Streaming responses split failure delivery by timing:
- **Pre-stream** (before headers are sent): HTTP error status + JSON envelope.
- **Post-start** (after stream headers are sent): SSE error frames with the JSON envelope, followed by stream closure. HTTP status remains 200.

#### OpenAI-compatible SSE error (post-start)
```
data: {"error":{"code":"rate_limit_exceeded","message":"Rate limit exceeded.","httpStatus":429,"type":"rate_limit_error","provider":"openai","retryAfterSeconds":30}}

data: [DONE]
```

#### Anthropic SSE error (post-start)
```
event: error
data: {"type":"error","error":{"code":"rate_limit_exceeded","message":"Rate limit exceeded.","httpStatus":429,"type":"rate_limit_error","provider":"anthropic","retryAfterSeconds":30}}
```

### Machine-Readable Codes

#### Pool Errors
Returned when no upstream call occurs because every key for the provider is in cooldown.

| `code` | HTTP | Fields |
|--------|------|--------|
| `poolUnavailable` | 503 | `provider`, `retryAfterSeconds` |

#### Gateway Errors
Returned when the gateway rejects or fails the request before contacting a provider.

| `code` | HTTP | Notes |
|--------|------|-------|
| `unauthorized` | 401 | Missing or invalid client token |
| `validationError` | 400 | Request body failed schema validation; includes `details` |
| `payloadTooLarge` | 413 | Request body exceeds configured limit |
| `badRequest` | 400 | Malformed request (Express-level) |
| `internalServerError` | 500 | Unhandled gateway exception |
| `dryRunDisabled` | 502 | Dry-run requested but request logging is disabled |
| `requestCancelled` | 499 | Client disconnected during an in-flight request |

#### Upstream Errors (Passthrough)
The gateway does not invent codes. Whatever the upstream sent is what the client sees, in both `code` and `upstreamCode`. The only normalization the gateway applies is wrapping the upstream's fields into the v1 envelope and (for transport failures) attaching a `code` of `connect_timeout`, `read_timeout`, or `tls_error` with `httpStatus: 503` / `504`.

| Source | `code` examples (as upstream sent) | Typical HTTP |
|--------|-----------------------------------|--------------|
| OpenAI / OpenAI-compatible | `rate_limit_exceeded`, `insufficient_quota`, `invalid_api_key`, `context_length_exceeded` | 400 / 401 / 402 / 403 / 404 / 422 / 429 / 500 / 502 / 503 / 504 |
| Anthropic | `credit_balance_too_low`, `invalid_request_error`, `authentication_error` | 400 / 401 / 402 / 403 / 404 / 429 / 500 / 502 / 503 / 504 |
| Gemini | `RESOURCE_EXHAUSTED`, `NOT_FOUND`, `UNAUTHENTICATED`, `PERMISSION_DENIED` | 400 / 401 / 403 / 404 / 429 / 500 / 502 / 503 / 504 |
| Transport (no HTTP response) | `connect_timeout`, `read_timeout`, `tls_error` | 503 / 504 |

The full upstream body is preserved in `upstreamBody` for clients that need every field.

### Status Forwarding
The client `httpStatus` is the upstream's `httpStatus`. When the upstream HTTP response is missing (transport failure), the gateway surfaces `502`. The HTTP-status-based key lifecycle policy operates on the same status value (see [Key Lifecycle & Cooldown Policy](#-key-lifecycle--cooldown-policy)).

### Retry-After Behavior
When `retryAfterSeconds` is present in the error envelope:
1. The value is included in the JSON body.
2. The gateway sets the `Retry-After` response header to the same value (numeric delay-seconds or HTTP-date).

---

## Getting Started

### Prerequisites
- Node.js v26.1+
- npm

### Installation
Clone the repository, copy the example configuration files, and install dependencies:
```bash
npm install
cp config.example.yaml config/config.yaml
cp .env.example .env
```

Edit `.env` with your API keys and client tokens, then adjust `config/config.yaml` as needed.

### Running Waypoint
Run the gateway in development mode (with file-watch and auto-restart):
```bash
npm run dev
```

Run in production mode:
```bash
npm start
```

### Running Tests
Waypoint features a comprehensive test suite (500+ tests across 70+ test files) executed via **Vitest**:
```bash
npm test
npm run test:watch   # watch mode
npm run ci           # lint + test
```

### Code Quality & Linting
Validate codebase constraints under ESLint (Airbnb-base preset):
```bash
npm run lint
```

### Docker
Build and run with Docker Compose:
```bash
docker compose up -d
```

Or build the image directly:
```bash
docker build -t waypoint .
docker run -p 20128:20128 -v ./config:/app/config waypoint
```

Mount `./config` to provide `config.yaml` and optionally mount `.env` for environment variables.

---

## Project Layout

Source and test files use **camelCase** naming throughout. The `src/` tree is organized by responsibility:

```
src/
├── index.js                 # Entry point (delegates to app/bootstrap.js)
├── app/                     # Startup wiring, Express app factory, service wiring
├── config/                  # YAML loader, Zod validators, validation errors
├── controllers/             # Protocol controllers (OpenAI, Anthropic)
├── domain/                  # Model routing, caching, request transformation
├── errors/                  # Error classifier, policy, envelopes, upstream errors
├── lifecycle/               # Graceful shutdown and signal handling
├── logging/                 # LogTape integration and per-request audit logging
├── middleware/              # Auth, rate limiting, Zod payload validation
├── providers/               # Provider adapters (Gemini, OpenAI, Anthropic, factory)
├── registry/                # API key pool, rotation, cooldown state
├── routes/                  # HTTP route definitions (OpenAI, Anthropic, health)
├── services/                # Orchestration, retry, key rotation, stream guard
├── streaming/               # SSE parsing and stream accumulation
├── transforms/              # Cross-protocol request/response translation
└── utils/                   # Shared utilities (header parsing, finish reason mapping)
```

Tests mirror this structure under `test/`, with cross-cutting HTTP tests in `test/integration/`, shared test helpers in `test/helpers/`, and fixtures in `test/fixtures/`.

---

## Configuration Guide

Waypoint reads configuration from `config/config.yaml` (copy from `config.example.yaml` at the repo root) or a path designated in `process.env.WAYPOINT_CONFIG_PATH`. Environment variables referenced in the YAML are loaded from `.env` (copy from `.env.example`).

Custom providers must specify a `baseUrl`; they default to `openai-compatible` when `type` is omitted and can also be configured as `anthropic-compatible`.

**Related documentation:**

- Cooldown settings and key lifecycle → [Key Lifecycle & Cooldown Policy](#-key-lifecycle--cooldown-policy)
- Client error envelope and cross-protocol error mapping → [Client Error API Contract](#-client-error-api-contract)
- Full configuration reference → [config.example.yaml](config.example.yaml)

### Complete YAML Example
```yaml
gateway:
  # Port the proxy server binds to
  port: 20128

  # Maximum number of retries for failed upstream provider calls
  globalRetryLimit: 3

  # Maximum duration for a single upstream request before Waypoint aborts it
  httpTimeoutMs: 120000

  # Optional timeout for streaming upstream calls only (see config.example.yaml).
  # When omitted, streams inherit httpTimeoutMs. Set higher than httpTimeoutMs
  # when long generations routinely exceed completion timeouts.
  # streamTimeoutMs: 600000

  # Size limit on inbound requests to prevent memory exhaustion
  maxPayloadSize: "10mb"

  # HTTP-status-based cooldown settings. See Key Lifecycle & Cooldown Policy
  # for the full policy. 401 / 403 retire the key; 402 / 408 / 429 / 5xx apply
  # a cooldown (429 uses exponential backoff); other 4xx and transport errors
  # leave the key state unchanged.
  cooldown:
    baseSeconds: 30      # 429 exponential backoff base
    maxSeconds: 3600     # 429 exponential backoff cap
    serverSeconds: 60    # 5xx default cooldown when Retry-After is absent

  # Routing algorithm: "round-robin" or "fill-first"
  routing:
    strategy: "round-robin"

  cors:
    allowedOrigins:
      - "*"

logging:
  enableConsole: true
  enableFile: true
  filePath: "./logs/waypoint.log"
  format: "json" # "json" | "text"
  level: "info" # "debug" | "info" | "warning" | "error" | "fatal"
  logRequests: true # Enables per-request lifecycle file logging
  requestLogPath: "./logs/requests"

clients:
  - name: "open-webui"
    token: "${OPEN_WEBUI_TOKEN}"
    rateLimit:
      windowMs: 60000
      max: 100
  - name: "codex-agent"
    token: "${CODEX_AGENT_TOKEN}"
    rateLimit:
      windowMs: 60000
      max: 30

providers:
  # Reserved provider names (gemini, anthropic, openai do not require baseUrl)
  gemini:
    keys:
      - "${GEMINI_API_KEY_1}"
      - "${GEMINI_API_KEY_2}"
    models:
      - id: "gemini-2.5-pro"
        aliases: ["gemini-pro"]
        actualModelId: "gemini-2.5-pro-preview-05-06"
        reasoningSupported: true
        reasoningEffort: "medium" # Default reasoning level
        fallbackModel: "openai/gpt-4o" # Route fallback on key exhaustion
      - id: "gemini-flash-lite-latest-high"
        actualModelId: "gemini-flash-lite-latest"
        reasoningSupported: true
        overrides:
          # Locked setting that cannot be overridden by client requests or headers
          reasoningEffort: "high"

  anthropic:
    keys:
      - "${ANTHROPIC_API_KEY_1}"
    models:
      - id: "claude-sonnet-4"
        aliases: ["sonnet"]
        actualModelId: "claude-sonnet-4-20250514"
        reasoningSupported: true
        reasoningEffort: "high"

  # Custom non-reserved provider example (OpenAI-compatible by default)
  local-ollama:
    baseUrl: "http://localhost:11434/v1"
    type: "openai-compatible" # "openai-compatible" | "anthropic-compatible"
    keys:
      - "dummy-key-required"
    models:
      - id: "llama3"
        actualModelId: "llama3:70b"
        reasoningSupported: false
```

---

## License
Waypoint is open-source software licensed under the [MIT License](./LICENSE).
