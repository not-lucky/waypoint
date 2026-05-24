# Waypoint: Unified LLM Proxy & Gateway

Waypoint is a lightweight, opinionated, developer-first local proxy and gateway. It provides a single entry point for sharing a pool of API keys across multiple LLM providers (Google Gemini, Anthropic Claude, OpenAI, and custom OpenAI/Anthropic-compatible services) with automatic load distribution, cooldown circuit breaking, and dynamic failure recovery.

> [!WARNING]
> **Waypoint is currently a Work In Progress (WIP)**. It is intended as a local companion gateway for developer workflows and is not certified for production use.

---

## 📌 Project Framing & Scope Rationale
Waypoint is designed to demonstrate systems-level clean architecture, protocol translation, and stateful in-memory key registry design. While comprehensive tools like LiteLLM exist for enterprise-scale multi-provider routing, Waypoint is optimized as a **zero-dependency, single-process local sidecar** that developer tools (like Open WebUI, Claude Code, or IDE extensions) can use locally without managing databases or external caches. 

All state—including rate limits, sequential rotations, and circuit breakers—is stored in-memory, ensuring near-zero latency and high portability.

---

## 🏛️ System Architecture

Waypoint enforces strict **Separation of Concerns** using a layered Clean Architecture model. Inbound client payloads are decrypted, authenticated, validated, and normalized before being passed to key registries and provider SDK adapters.

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
               └────────────────────────┬────────────────────────┘
                                         │
                                         ▼
               ┌─────────────────────────────────────────────────┐
               │              Protocol Controllers               │
               │  - Translate Incoming Protocol to Unified Model │
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
               │  - Provider Adapters (Vercel AI SDK wrappers)  │
               │  - Mock Strategy Registry (for unit tests)      │
               └─────────────────────────────────────────────────┘
```

---

## ⚡ Core Features

### 1. Robust Configuration & Hot-Reloading
- **Environment Interpolation**: Resolves `${ENV_VAR}` tokens in `config/config.yaml` during boot and on updates.
- **FS Watcher Hot-Reload**: Watches the YAML file and updates key pools on-the-fly without dropping active requests or restarting the process.
- **Fail-Fast Structural Zod Validation**: Validates the entire configuration structure on load, stopping startup instantly on format errors to prevent silent configuration failures.

### 2. API Key Pool Management & Circuit Breaking
- Maintains stateful `KeyObject` telemetry in-memory for each provider key pool.
- **Routing Strategies**:
  - `round-robin`: Rotates keys sequentially per request to balance load evenly across active keys.
  - `fill-first`: Uses the first available key and fails over only when exhausted, optimizing for upstream **prompt cache locality**.
- **Circuit Breaking**:
  - **429 Rate Limits**: Cooldowns key with exponential backoff (`base_seconds × 2ⁿ`, capped at `max_seconds`), then auto-reactivates it.
  - **402/403 Quota Errors**: Marks the key as permanently exhausted.
  - **Other errors**: Briefly disables the key under a transient cooldown period.

### 3. Unified Reasoning Model
- Normalizes reasoning/thinking efforts using standard levels (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`).
- Maps levels dynamically to adapter specifications:
  - **OpenAI**: Translates to `reasoning_effort` (`low`, `medium`, `high`).
  - **Anthropic (Claude 3.7+)**: Interpolates extended thinking `budget_tokens`.
  - **Gemini (Flash-Lite / Pro)**: Translates to model-specific native thinking levels (`minimal`, `low`, `medium`, `high`).

### 4. Settings Precedence Hierarchy
Waypoint resolves parameters (e.g., `temperature`, `max_tokens`, `reasoning_effort`) using a deterministic hierarchy:
1. **Flat Model Defaults**: Settings configured directly at the root of a model's YAML config block.
2. **Client Payload**: Body parameters supplied in the incoming client HTTP call.
3. **Client Headers**: Custom ingress override headers (`x-gateway-thinking-level` or `x-gateway-temperature`).
4. **Configuration Overrides**: Values inside the model's `overrides` block, acting as a locked policy that client options cannot bypass.

### 5. Automated Fallback Routing
- If all API keys in a provider pool are rate-limited or exhausted for a given model, Waypoint automatically failovers to a designated `fallback_model` (e.g., from Gemini to OpenAI) to maintain request reliability.

### 6. Logging & Telemetry Auditing
- **LogTape Integration**: Integrated via `@logtape/logtape` and `@logtape/file` to support text-based developer formats or JSON telemetry streams.
- **Per-Request Auditing**: If `log_requests` is enabled, captures every phase of the request/response lifecycle under `request_log_path` in separate files:
  - `01_client_request.json`: Incoming HTTP client request headers (redacted) and body.
  - `02_provider_request.json`: Payload translated and sent to the upstream provider.
  - `03_provider_response.json`: Raw response received from the upstream provider.
  - `04_client_response.json`: Final unified payload sent to the client.
  - `05_event_stream.jsonl`: Complete chunk-by-chunk stream logs for Server-Sent Events (SSE).

### 7. Core Gateway Operations
- Secure endpoint authentication with bearer token mappings (`Authorization: Bearer <token>`).
- Client-level sliding window rate limiting.
- Ingress payload size constraints and CORS controls.

---

## 🚀 Getting Started

### Prerequisites
- Node.js v18+
- npm

### Installation
Clone the repository and install dependencies:
```bash
npm install
```

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
Waypoint features a comprehensive test suite (627 unit, integration, and edge-case tests) executed via **Vitest**:
```bash
npm test
```

### Code Quality & Linting
Validate codebase constraints under ESLint (Airbnb-base preset):
```bash
npm run lint
```

---

## ⚙️ Configuration Guide

Waypoint reads configuration from `config/config.yaml` or a path designated in `process.env.WAYPOINT_CONFIG_PATH`.

### Complete YAML Example
```yaml
gateway:
  # Port the proxy server binds to
  port: 20128
  
  # Maximum retries for failed upstream provider calls
  global_retry_limit: 3
  
  # Size limit on inbound requests to prevent memory exhaustion
  max_payload_size: "10mb"
  
  # Cooldown limits for rate-limiting exponential backoffs
  cooldown:
    base_seconds: 30
    max_seconds: 3600
    
  # Routing algorithm: "round-robin" or "fill-first"
  routing:
    strategy: "round-robin"
    
  cors:
    allowed_origins:
      - "*"

logging:
  enable_console: true
  enable_file: true
  file_path: "./logs/waypoint.log"
  format: "json" # "json" | "text"
  level: "info" # "debug" | "info" | "warning" | "error" | "fatal"
  log_requests: true # Enables per-request lifecycle file logging
  request_log_path: "./logs/requests"

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
  # Reserved provider name (gemini, anthropic, openai do not require base_url)
  gemini:
    keys:
      - "${GEMINI_API_KEY_1}"
      - "${GEMINI_API_KEY_2}"
    models:
      - id: "gemini-2.5-pro"
        aliases: ["gemini-pro"]
        actual_model_id: "gemini-2.5-pro-preview-05-06"
        reasoning_supported: true
        reasoning_effort: "medium" # Default reasoning level
        fallback_model: "openai/gpt-4o" # Route fallback on key exhaustion
      - id: "gemini-flash-lite-latest-high"
        actual_model_id: "gemini-flash-lite-latest"
        reasoning_supported: true
        overrides:
          # Locked setting that cannot be overridden by client requests or headers
          reasoning_effort: "high"

  anthropic:
    keys:
      - "${ANTHROPIC_API_KEY_1}"
    models:
      - id: "claude-sonnet-4"
        aliases: ["sonnet"]
        actual_model_id: "claude-sonnet-4-20250514"
        reasoning_supported: true
        reasoning_effort: "high"

  # Custom non-reserved provider example (base_url is required)
  local-ollama:
    base_url: "http://localhost:11434/v1"
    type: "openai-compatible" # "openai-compatible" | "anthropic-compatible"
    keys:
      - "dummy-key-required"
    models:
      - id: "llama3"
        actual_model_id: "llama3:70b"
        reasoning_supported: false
```

### Key Resolution Policies
> [!IMPORTANT]
> - **Fail-Fast**: If non-key environment variables (e.g. client tokens or port settings) resolve to empty values, Waypoint aborts startup immediately.
> - **Degraded Mode**: If some (but not all) API keys for a provider resolve to empty values, Waypoint emits a warning and boots using the remaining active keys. If *all* keys for a configured provider are missing, startup aborts.

---

## 🛡️ License
Waypoint is open-source software licensed under the [MIT License](./LICENSE).
