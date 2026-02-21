# Waypoint: Core Configuration & Key Registry

Waypoint is a lightweight, opinionated local proxy and gateway designed for developer-first workflows. It provides a single entry point for sharing a pool of API keys across multiple LLM providers with automatic load distribution, cooldown circuit breaking, and failure recovery.

WIP. DONT USE THIS.

---

## Key Features

1. **Robust Configuration & Hot-Reloading**:
   - Parses the configuration file and resolves environment variables dynamically (e.g., `${ENV_VAR}`).
   - Automatically reloads key pools and settings when configuration files are updated on disk, without restarting the proxy process.
   - Deep structural validation of all settings on startup (fail-fast policy).

2. **In-Memory API Key Pool Management**:
   - Rotates active API keys per provider using load-balancing strategies:
     - **Round-Robin** (default): Sequentially routes requests across active keys to distribute load evenly.
     - **Fill-First**: Uses the first available key in the pool entirely before failing over, which is ideal for prompt cache locality.
   - Handles automated circuit breaking and cooldown based on upstream errors:
     - **429 (Rate Limited)**: Triggers an exponential backoff cooldown.
     - **402 / 403 (Quota/Forbidden)**: Marks keys as permanently exhausted.
     - **Other Errors**: Applies a brief cooldown for transient failures.

3. **HTTP Server Ingress**:
   - Exposes a `/health` endpoint to check gateway status.

---

## Getting Started

### Prerequisites
- Node.js (v18+ recommended)
- npm

### Installation
Clone the repository and install the dependencies:
```bash
npm install
```

### Running Waypoint
To run Waypoint in development mode with auto-reload:
```bash
npm run dev
```

To run Waypoint in production mode:
```bash
npm start
```

### Running Tests
Unit and integration tests are run via **Vitest**:
```bash
npm test
```

---

## Configuration Guide

Waypoint reads configuration from `config/config.yaml`. Environment variables inside the YAML file (formatted as `${ENV_VAR}`) are automatically interpolated at startup.

### Example Configuration:
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
  file_path: "./logs/Waypoint.log"
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

### Configuration Rules & Fail-Fast Behavior

> [!WARNING]
> Waypoint enforces a **fail-fast** policy. Any missing client tokens, invalid numeric configuration fields, or structural configuration issues will log a fatal error and abort startup.
>
> However, if some keys are missing or invalid within a provider's `keys:` array, Waypoint will print a warning and start in degraded mode with the remaining functional keys. If *all* keys for a configured provider are missing, the server will abort execution immediately.

---

## API Endpoints

### 1. Gateway Health Status
* **Path**: `GET /health`
* **Response Example**:
```json
{
  "status": "ok"
}
```
