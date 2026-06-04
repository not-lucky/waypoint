# Waypoint: Unified LLM Proxy & Gateway

Waypoint is a lightweight, opinionated, developer-first local proxy and gateway. It provides a single entry point for sharing a pool of API keys across multiple LLM providers (Google Gemini, Anthropic Claude, OpenAI, OpenRouter, and custom OpenAI/Anthropic-compatible services) with automatic load distribution, cooldown circuit breaking, and dynamic failure recovery.

Waypoint accepts OpenAI- and Anthropic-compatible HTTP APIs, preserves provider-specific request fields, and supports OpenAI-style tool/function calling, multimodal text-plus-image messages, reasoning/thinking normalization, SSE streaming, and dry-run inspection.

> [!WARNING]
> **Waypoint is currently a Work In Progress (WIP)**. It is intended as a local companion gateway for developer workflows and is not certified for production use.

---

## 📌 Project Framing & Scope Rationale
Waypoint is designed to demonstrate systems-level clean architecture, protocol translation, and stateful in-memory key registry design. While comprehensive tools like LiteLLM exist for enterprise-scale multi-provider routing, Waypoint is optimized as a **zero-external-infrastructure, single-process local sidecar** that developer tools (like Open WebUI, Claude Code, or IDE extensions) can use locally without managing databases or external caches.

All state—including rate limits, sequential rotations, and circuit breakers—is stored in-memory, ensuring near-zero latency and high portability.

---

## 🏛️ System Architecture

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
               │  - Tool/Multimodal Schema - Passthrough         │
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

## ⚡ Core Features

### 1. Robust Configuration Management
- **Environment Interpolation**: Resolves `${ENV_VAR}` tokens in `config/config.yaml` during boot.
- **Fail-Fast Structural Zod Validation**: Validates the entire configuration structure on load, stopping startup instantly on format errors to prevent silent configuration failures.

### 2. API Key Pool Management & Circuit Breaking
- Maintains stateful `KeyObject` telemetry in-memory for each provider key pool.
- **Routing Strategies**:
  - `round-robin`: Rotates keys sequentially per request to balance load evenly across active keys.
  - `fill-first`: Uses the first available key and fails over only when exhausted, optimizing for upstream **prompt cache locality**.
- **Circuit Breaking**:
  - **429 Rate Limits**: Cooldowns key with exponential backoff (`baseSeconds × 2ⁿ`, capped at `maxSeconds`), then auto-reactivates it.
  - **402/403 Quota Errors**: Marks the key as permanently exhausted.
  - **Other errors**: Briefly disables the key under a transient cooldown period.

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

---

## 🚀 Getting Started

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
Waypoint features a comprehensive test suite (375 unit, integration, and edge-case tests) executed via **Vitest**:
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

---

## Project Layout

Source and test files use **camelCase** naming throughout. The `src/` tree is organized by responsibility:

```
src/
├── index.js                 # CLI entry point (delegates to app/bootstrap.js)
├── app/                     # Startup wiring and Express app factory
├── lifecycle/               # Graceful shutdown and signal handling
├── adapters/                # Provider HTTP adapters (shared/ for cross-adapter utilities, gemini/ for Gemini internals)
├── config/                  # YAML loader and Zod validators
├── controllers/             # Protocol translation boundaries (OpenAI, Anthropic)
├── domain/                  # Model routing, caching, and request transformation
├── logging/                 # LogTape integration and per-request audit logging
├── streaming/               # SSE parsing and stream accumulation utilities
├── common/                  # Shared errors and string helpers
├── middleware/              # Auth, rate limiting, payload validation
├── registry/                # API key pool state and teardown hooks
├── services/                # Orchestration, retry, and failover logic
├── routes/                  # HTTP route definitions
└── translators/             # Cross-protocol request/response translation
```

Tests mirror this structure under `test/`, with cross-cutting HTTP tests in `test/integration/`, shared test helpers in `test/helpers/`, and fixtures in `test/fixtures/`.

---

## ⚙️ Configuration Guide

Waypoint reads configuration from `config/config.yaml` (copy from `config.example.yaml` at the repo root) or a path designated in `process.env.WAYPOINT_CONFIG_PATH`. Environment variables referenced in the YAML are loaded from `.env` (copy from `.env.example`).

Custom providers must specify a `baseUrl`; they default to `openai-compatible` when `type` is omitted and can also be configured as `anthropic-compatible`.

### Complete YAML Example
```yaml
gateway:
  # Port the proxy server binds to
  port: 20128

  # Maximum number of retries for failed upstream provider calls
  globalRetryLimit: 3

  # Maximum duration for a single upstream request before Waypoint aborts it
  httpTimeoutMs: 120000

  # Size limit on inbound requests to prevent memory exhaustion
  maxPayloadSize: "10mb"

  # Cooldown limits for rate-limiting exponential backoffs
  cooldown:
    baseSeconds: 30
    maxSeconds: 3600

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

## 🛡️ License
Waypoint is open-source software licensed under the [MIT License](./LICENSE).
