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
- **Circuit Breaking & Tiered Cooldowns**:
  Instead of permanently exhausting keys on all errors, Waypoint uses a tiered lifecycle policy (T0–T5) where keys automatically recover after a cooldown period. For details, see the [Key Lifecycle & Cooldown Policy](#-key-lifecycle--cooldown-policy) section below.

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
- **Health endpoint** (`GET /health`): requires authentication; returns `status` (`ok` or `degraded`), `uptimeSeconds`, per-provider key pool stats (`providers`), and routing state (`routing`).
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

Waypoint manages a pool of upstream API keys per provider. When an upstream request fails, the gateway decides whether to permanently exhaust a key, apply a tiered cooldown, or take no key action. Policy decisions use **structured error meaning** (`code` and `category`)—never bare HTTP status codes alone.

### Core Rule
- `KeyObject.exhausted = true` **only** when `code === 'invalid_api_key'` (revoked, disabled, or incorrect credential).
- Billing, permission, quota, rate-limit, and transient server conditions use **tiered cooldowns**. Keys reactivate automatically after the cooldown timer expires.

### Tier Matrix

| Tier | Trigger codes / conditions | `exhausted` | Cooldown source | Reactivate after timer |
|------|---------------------------|-------------|-----------------|------------------------|
| **T0 — Terminal credential** | `invalid_api_key` | `true` | — | never |
| **T1 — Billing recovery** | HTTP 402; `insufficient_quota`, `billing_hard_limit_reached`; quota-style 429 (`daily_tokens_exceeded`, message match *"exceeded your current quota"*) | `false` | `billingSeconds` (default 3600) or `Retry-After` | yes |
| **T2 — Permission recovery** | `forbidden`, `region_not_supported`, `org_membership_required`, `ip_not_authorized` | `false` | `permissionSeconds` (default 1800) or `Retry-After` | yes |
| **T3 — Rate limit** | RPM/TPM/concurrent 429: `rate_limit_exceeded`, `tokens_per_minute_exceeded`, `concurrent_requests_exceeded` | `false` | `Retry-After` or exponential (`baseSeconds` × 2^n, cap `maxSeconds`) | yes |
| **T4 — Server transient** | 500, 502, 503, 504; `internal_server_error`, `engine_overloaded`, `service_unavailable`, `gateway_timeout`, `bad_gateway` | `false` | `serverSeconds` (default 60) or exponential | yes |
| **T4b — Slow down** | `rate_reduction_required` (503 slow-down message) | `false` | `max(retryAfterSeconds, slowDownMinimumSeconds)` — default minimum 900s | yes |
| **T5 — No key action** | 400, 404, 422; content policy codes (`content_filter`, `moderation_flagged`, `content_unavailable_legal`, etc.) | unchanged | none | — |

### Tier Behavior Notes
- **T0** is the only tier that permanently disables a key. Operators must replace or re-enable the credential out of band.
- **T1–T4b** set `active = false` and schedule cooldown with `reactivate = true`. The key becomes available again when the timer fires.
- **T5** errors indicate request or endpoint problems shared by every key. Retrying with a different key cannot succeed; no cooldown is applied.

### Critical Distinction: Two Kinds of 429
Upstream providers use HTTP 429 for both rate limiting and quota exhaustion. These must **not** share cooldown logic:

| Kind | Tier | Behavior |
|------|------|----------|
| RPM / TPM / concurrent limits | **T3** | Rotate keys, honor `Retry-After`, apply exponential backoff |
| Quota / billing exhaustion | **T1** | Long billing cooldown — do **not** aggressively rotate keys against a depleted account |

Quota-style 429 is identified by codes such as `daily_tokens_exceeded` or message patterns including *"exceeded your current quota"*.

### Gateway Misconfiguration (No Key Fault)
Some error codes reflect gateway configuration problems, not upstream key health:
- **`no_api_key`**: Skip `flagFailure` entirely. This indicates the gateway failed to send an Authorization header to the upstream provider (a gateway config bug, not an unhealthy credential).
- **`poolUnavailable`**: Pool-level client error when no upstream call occurred; not a per-key lifecycle event.

### Code-to-Tier Mapping
Aligned with the OpenAI API error codes guide.

| Upstream condition | HTTP | Classifier `code` | Tier |
|--------------------|------|-------------------|------|
| Invalid / incorrect API key | 401 | `invalid_api_key` | T0 |
| Must be member of an organization | 401 | `org_membership_required` | T2 |
| IP not authorized | 401 | `ip_not_authorized` | T2 |
| Country, region, or territory not supported | 403 | `region_not_supported` | T2 |
| Permission denied | 403 | `forbidden` | T2 |
| Insufficient quota / billing | 402 | `insufficient_quota` | T1 |
| Billing hard limit reached | 402 | `billing_hard_limit_reached` | T1 |
| Rate limit (requests) | 429 | `rate_limit_exceeded` | T3 |
| Tokens per minute exceeded | 429 | `tokens_per_minute_exceeded` | T3 |
| Concurrent requests exceeded | 429 | `concurrent_requests_exceeded` | T3 |
| Quota / daily tokens exceeded | 429 | `daily_tokens_exceeded` | **T1** |
| Server error | 500 | `internal_server_error` | T4 |
| Engine overloaded | 503 | `engine_overloaded` | T4 |
| Slow down | 503 | `rate_reduction_required` | T4b |
| Request validation / content policy | 400, 404, 422, 451 | validation and content policy codes | T5 |

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
| `code` | Yes | Stable machine-readable identifier; primary key for client branching |
| `message` | Yes | Human-readable description |
| `httpStatus` | Yes | HTTP status returned to the client (may differ from upstream) |
| `type` | Upstream only | Provider-style category string from the classifier (e.g. `rate_limit_error`, `authentication_error`); omitted for gateway and pool errors |
| `provider` | Upstream + pool | Provider name (e.g. `openai`, `anthropic`, `gemini`); omitted for pure gateway faults |
| `retryAfterSeconds` | When relevant | Seconds until retry is advisable; also sets the `Retry-After` response header |
| `details` | Gateway validation only | Optional array of field-level validation issues (gateway extension) |

### Security Rules
- Never replace the entire response body with a raw upstream payload.
- Do not expose unredacted upstream trace tokens, account IDs, or internal policy details at the response root. Full upstream details are retained in server-side logs with redaction.

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

#### Upstream Errors
Returned when a provider request was attempted and failed. Codes are assigned by the internal error classifier.

##### Authentication and permission
| `code` | `type` | Typical HTTP |
|--------|--------|--------------|
| `invalid_api_key` | `authentication_error` | 401 |
| `no_api_key` | `authentication_error` | 401 |
| `forbidden` | `permission_denied_error` | 403 |

##### Billing
| `code` | `type` | Typical HTTP |
|--------|--------|--------------|
| `insufficient_quota` | `billing_error` | 402 |
| `billing_hard_limit_reached` | `billing_error` | 402 |
| `daily_tokens_exceeded` | `billing_error` | 429 (quota-style upstream status) |

##### Rate limiting
| `code` | `type` | Typical HTTP |
|--------|--------|--------------|
| `rate_limit_exceeded` | `rate_limit_error` | 429 |
| `tokens_per_minute_exceeded` | `rate_limit_error` | 429 |
| `concurrent_requests_exceeded` | `rate_limit_error` | 429 |

##### Validation and content policy
| `code` | `type` | Typical HTTP |
|--------|--------|--------------|
| `invalid_parameter_value` | `invalid_request_error` | 400 |
| `context_length_exceeded` | `invalid_request_error` | 400 |
| `max_tokens_too_large` | `invalid_request_error` | 400 |
| `invalid_message_role` | `invalid_request_error` | 400 |
| `invalid_tool_definition` | `invalid_request_error` | 400 |
| `incompatible_params` | `invalid_request_error` | 400 |
| `missing_required_param` | `invalid_request_error` | 400 |
| `invalid_type` | `invalid_request_error` | 400 |
| `unprocessable_entity` | `invalid_request_error` | 422 |
| `request_too_large` | `invalid_request_error` | 413 |
| `content_filter` | `content_policy_violation` | 400 |
| `moderation_flagged` | `content_policy_violation` | 400 |
| `content_unavailable_legal` | `content_policy_violation` | 451 |

##### Model and resource
| `code` | `type` | Typical HTTP |
|--------|--------|--------------|
| `model_not_found` | `not_found_error` | 404 |
| `endpoint_not_found` | `not_found_error` | 404 |
| `unsupported_feature` | `invalid_request_error` | 400 |
| `engine_overloaded` | `overloaded_error` | 503 |

##### Server and transport
Transport errors omit `type` because they are not provider-classified responses.

| `code` | `type` | Typical HTTP |
|--------|--------|--------------|
| `internal_server_error` | `api_error` | 502 |
| `service_unavailable` | `api_error` | 503 |
| `gateway_timeout` | `api_error` | 504 |
| `bad_gateway` | `api_error` | 502 |
| `upstream_error` | `api_error` | varies |
| `connect_timeout` | — | 503 |
| `read_timeout` | — | 504 |
| `tls_error` | — | 503 |

### Status Forwarding
The client `httpStatus` may differ from the upstream HTTP status:

| Upstream status | Client `httpStatus` | Notes |
|-----------------|---------------------|-------|
| 500 | 502 | Bad gateway semantics |
| 401 / 402 / 403 / 429 | As classified | `code` is the stable machine identifier |
| 400 / 404 / 422 | Forward | No key lifecycle action (T5) |
| Other 5xx | 502 or forward | Per routing rules |

### Retry-After Behavior
When `retryAfterSeconds` is present in the error envelope:
1. The value is included in the JSON body.
2. The gateway sets the `Retry-After` response header to the same value (numeric delay-seconds or HTTP-date).

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

---

## Getting Started

### Prerequisites
- Node.js v18+
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
Waypoint features a comprehensive test suite (478 tests across 59 test files) executed via **Vitest**:
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

- Cooldown tiers and key lifecycle → [Key Lifecycle & Cooldown Policy](#-key-lifecycle--cooldown-policy)
- Client error envelope and code taxonomy → [Client Error API Contract](#-client-error-api-contract)
- Full configuration reference with tier comments → [config.example.yaml](config.example.yaml)

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

  # Tiered cooldown settings — see Key Lifecycle & Cooldown Policy section for T0–T5 tier mapping
  cooldown:
    baseSeconds: 30              # T3: rate-limit exponential base
    maxSeconds: 3600             # T3: exponential cap
    billingSeconds: 3600         # T1: billing/quota (402, daily_tokens_exceeded)
    permissionSeconds: 1800      # T2: permission recovery
    serverSeconds: 60            # T4: transient server errors
    slowDownMinimumSeconds: 900  # T4b: OpenAI "Slow Down" minimum

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
