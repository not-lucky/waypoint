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
| HTTP server + `/health` | ✅ Done | Express server on configured port |
| ESLint (airbnb-base) | ✅ Done | Enforced across all source files |
| Request routing / proxying | ⬜ Planned | Controllers & middleware not yet implemented |
| Client authentication | ⬜ Planned | Token validation middleware not yet implemented |
| Per-client rate limiting | ⬜ Planned | — |
| Provider adapters (Gemini, OpenAI, …) | ⬜ Planned | Adapter implementations not yet written |
| Logging (file + console) | ⬜ Planned | Config schema present; logger not wired up |
| Model aliasing / fallback routing | ⬜ Planned | Config schema present; routing logic not yet implemented |

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

### 3. ProviderFactory
- A simple adapter registry — `register(name, adapter)` / `get(name)` — ready to be wired up with provider-specific adapters.

### 4. HTTP Server
- Express server that binds to `config.gateway.port`.
- Exposes a `GET /health` endpoint returning `{ "status": "ok" }`.

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

Production mode:
```bash
pnpm start
```

### Running Tests
68 unit tests across 9 test files, run via **Vitest**:
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
  cooldown:
    base_seconds: 30
    max_seconds: 3600
  routing:
    strategy: "round-robin" # "round-robin" or "fill-first"

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
