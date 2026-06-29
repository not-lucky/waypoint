# Waypoint Domain Context

## Project Overview

Waypoint is a single-binary local LLM proxy and gateway that provides a unified HTTP surface for multiple upstream LLM providers. It manages API key pools with automatic failover, HTTP-status-driven cooldown, and cross-protocol translation.

## Core Domain Concepts

### Gateway & Proxy
- **Gateway**: The central Waypoint service that accepts client requests and orchestrates provider communication
- **Proxy**: Acts as an intermediary between clients and upstream LLM providers, translating protocols and managing key lifecycle

### Providers & Models
- **Provider**: An upstream LLM service (Gemini, Anthropic, OpenAI, Cloudflare Workers AI, or any OpenAI/Anthropic-compatible endpoint configured with `baseUrl`, e.g. OpenRouter, Requesty, local Ollama)
- **Reserved Provider**: Built-in provider with predefined configuration (gemini, anthropic, openai, cloudflare)
- **Custom Provider**: User-defined provider configured with a baseUrl for OpenAI- or Anthropic-compatible endpoints
- **Provider Type**: Optional field for custom providers specifying compatibility: "openai-compatible" (default) or "anthropic-compatible"
- **Model**: A specific LLM instance within a provider (e.g., gemini-2.5-pro, gpt-4o)
- **Fallback Model**: Alternate model to use when the primary provider's key pool is exhausted
- **Actual Model ID**: The underlying model ID to call upstream, different from the exposed model ID
- **Model Aliases**: Alternative IDs that can be used to reference a model

### Key Pool Management
- **Key Pool**: Collection of API keys for a specific provider, used for load balancing and failover
- **Key Rotation**: Strategy for selecting keys from the pool (round-robin or fill-first)
- **Round-robin**: Key selection strategy that cycles through keys sequentially
- **Fill-first**: Key selection strategy that favors upstream prompt-cache locality by reusing keys
- **Key Lifecycle**: State transitions of API keys based on upstream HTTP status codes
- **Routing Strategy**: Configuration option that determines key selection behavior (round-robin or fill-first)

### Key States & Actions
- **Active**: Key is available for use
- **Cooldown**: Key is temporarily unavailable due to rate limiting or server errors
- **Retired**: Key is permanently removed from the pool due to authentication failures
- **Retire**: Permanent key removal triggered by 401/403 status codes
- **Cooldown**: Temporary key unavailability triggered by 402/408/429/5xx status codes

### Cooldown Policy
- **Base Seconds**: Starting cooldown duration (configurable)
- **Max Seconds**: Maximum cooldown duration cap
- **Server Seconds**: Default cooldown for server errors
- **Exponential Backoff**: Cooldown duration that doubles on consecutive 429 failures
- **Retry-After**: Upstream-provided header that overrides calculated cooldown

### Protocols & Translation
- **Ingress Protocol**: Client-facing protocol (OpenAI or Anthropic compatible)
- **Egress Protocol**: Provider-facing protocol (provider-specific)
- **Hub Format**: OpenAI protocol used as the canonical internal representation (no separate canonical directory)
- **Cross-protocol Translation**: Converting between different LLM API formats
- **Unified Model**: OpenAI-shaped internal representation of requests/responses

### Request Processing
- **Client**: External service making requests to the gateway (e.g., Open WebUI)
- **Client Token**: Bearer token used for client authentication
- **Rate Limit**: Per-client sliding window rate limiting
- **Sliding Window**: Rate limiting technique that tracks requests within a time window
- **Zod Validation**: Schema validation using the Zod library
- **Orchestrator**: Component that manages key selection, dispatch, and retry logic (split into UnifiedOrchestrator for entry point and OrchestrationEngine for fallback loop)
- **Provider Adapter**: Component that handles provider-specific communication
- **Middleware**: Web-layer request/response processing in Express (`src/infrastructure/web/middleware/`)

### Streaming & Events
- **SSE (Server-Sent Events)**: Streaming protocol for real-time response delivery
- **Stream Guard**: Application-layer component (`src/application/retry/streamGuard.js`) that monitors and aborts streaming connections on cancellation
- **Event Stream**: Sequence of SSE events for streaming responses

### Error Handling
- **Error Envelope**: Standardized error response format
- **Upstream Error**: Error originating from the provider
- **Gateway Error**: Error originating from the Waypoint service
- **Pool Error**: Error related to key pool management
- **HTTP-status-driven**: Key lifecycle decisions based on HTTP status codes
- **Transport Failure**: Network-level error preventing provider communication

### Observability
- **Audit Log**: Per-request logging of client/provider requests and responses
- **Telemetry**: Operational metrics and health information
- **Prometheus Metrics**: Standard metrics format for monitoring
- **Health Endpoint**: API endpoint returning system status and pool state
- **Metrics Endpoint**: API endpoint returning Prometheus-formatted metrics

### Configuration
- **Config File**: YAML configuration file defining gateway, clients, and providers
- **Environment Interpolation**: Resolving `${ENV}` placeholders from process environment
- **Bearer-token Auth**: Authentication mechanism using bearer tokens
- **CORS**: Cross-Origin Resource Sharing configuration
- **Validation**: Zod-based config validation with 10 validator files (validator.js, clientValidator.js, gatewayValidator.js, loggingValidator.js, providerValidator.js, configUtils.js, configKeyUtils.js, cooldownDefaults.js, validationHelpers.js, loader.js)
- **Gateway Settings**: Configuration options like globalRetryLimit, httpTimeoutMs, streamTimeoutMs, maxPayloadSize, routing strategy
- **Model Settings**: Per-model configuration including temperature, maxTokens, reasoningSupported, reasoningEffort, overrides
- **Provider-Level Settings**: Default settings that apply to all models on a provider unless overridden at model level

### Reasoning & Thinking
- **Reasoning Content**: Special field for models that support thinking/reasoning capabilities
- **Reasoning Supported**: Model capability flag indicating whether the model supports reasoning/thinking; defaults to true unless explicitly disabled
- **Reasoning Effort**: Unified reasoning level controlling thinking intensity (minimal, low, medium, high, xhigh, max)
- **Extract Reasoning from Think Blocks**: Setting to split assistant content containing reasoning into reasoning_content field
- **Reasoning Inheritance**: Provider-level reasoning settings that models inherit unless explicitly overridden

### Development Operations
- **Dry-run**: Testing mode that returns what would be sent upstream without making the call
- **Single Binary**: Self-contained deployment with no external dependencies
- **Graceful Shutdown**: Clean process termination handling signals
- **Global Retry Limit**: Maximum number of retry attempts for failed upstream calls
- **HTTP Timeout**: Maximum duration for a single upstream request
- **Stream Timeout**: Optional timeout specifically for streaming requests
- **Max Payload Size**: Maximum allowed request payload size

## Architecture Patterns

### Clean Architecture
The codebase follows Clean Architecture principles with clear separation of concerns:
- **Adapters**: External interface handling (inbound/outbound protocols, transforms)
- **Application**: Business logic and orchestration (orchestrator, orchestrationEngine, retry strategies)
- **Domain**: Core business entities and rules (errors, keys, routing)
- **Infrastructure**: External system integration (HTTP, lifecycle, logging, monitoring, web)
- **Utils**: Shared utilities (streaming helpers)

### Context Map

The system is organized into three main contexts with clear dependency boundaries:

**Core Gateway Context** (`src/domain/`, `src/application/`)
- Domain entities: KeyRegistry, KeyPool, routing algorithms, cooldown policies
- Application orchestration: Request processing and retry/fallback orchestration
- Orchestration engine: UnifiedOrchestrator and outer fallback loop (orchestrationEngine.js)

**Protocol Adapters Context** (`src/adapters/`)
- Inbound controllers: OpenAI, Anthropic protocol request parsing
- Outbound adapters: Provider-specific HTTP communication
- Transform functions: Protocol ↔ Canonical IR translation

**Infrastructure Context** (`src/infrastructure/`, `src/utils/`)
- Web server: Express.js setup, routing, middleware (createApp.js for app factory, server.js for HTTP server setup, wireServices.js for dependency injection)
- HTTP client: undici dispatcher with connection pooling
- Logging: LogTape integration and audit trails
- Monitoring: Health endpoints and Prometheus metrics
- Lifecycle: Graceful shutdown and teardown registries

Dependencies flow inward: Infrastructure → Adapters → Application → Domain

### Request Flow
1. Client request → Authentication → Rate limiting → Zod validation
2. Protocol controller → UnifiedOrchestrator → OrchestrationEngine (fallback loop) → Key rotation loop
3. Provider adapter → Upstream HTTP → Response translation
4. Return to client in ingress protocol format

**Orchestration Split:**
- `UnifiedOrchestrator` (orchestrator.js): Entry point, handles client disconnects, abort controller management, request overrides
- `OrchestrationEngine` (orchestrationEngine.js): Outer fallback loop, handles fallback routing between providers/models, prevents infinite loops

### Core Gateway Domain Details

**Key Lifecycle States:**
- **active** — Key is available for routing
- **cooldown** — Key is temporarily unavailable (rate limits, transient errors)
- **retired** — Key is permanently removed (bad credentials)

**Routing Strategies:**
- **Round-Robin** — Distributes load evenly across keys by cycling through them sequentially. Best general-purpose default for even RPM distribution.
- **Fill-First** — Exhausts keys in order, maximizing cache locality by using the same key until it fails. Best when prompt cache locality matters more than load distribution.

**Error Classification:**
Upstream HTTP status codes drive key actions:
| Status | Action | Duration |
|--------|--------|----------|
| 401/403 | retire | permanent |
| 402/408/5xx | cooldown | serverSeconds (60s default) |
| 429 | cooldown | exponential backoff |
| other 4xx | none | none |
| transport error | none | none |

**Routing Components:**
- `router.js`: Model resolution and provider matching from configuration
- `transformer.js`: Applying model configuration to requests (e.g., fallbackModel, provider-specific settings)
- `cache.js`: Caching resolved model configurations for performance

**Model Configuration Inheritance:**
- Provider-level settings (e.g., extractReasoningFromThinkBlocks) apply to all models unless overridden
- Model-level settings take precedence over provider-level defaults
- The `overrides` field provides locked settings that always override client-supplied values
- Settings that support inheritance: extractReasoningFromThinkBlocks

### Infrastructure Details

**HTTP Dispatcher (undici):**
- High-performance HTTP client with connection pooling
- Connection reuse for reduced latency
- Experimental HTTP/2 support (via opt-in config)
- Configurable timeouts and pool sizes

**Request Audit Logging:**
- Complete request lifecycle recording for debugging and compliance
- Log files: `01_client_request.json`, `02_provider_request.json`, `03_provider_response.json`, `04_client_response.json`
- Location: `logs/requests/YYYY-MM-DD_HH-MM-SS_<id>/`
- Configuration: `logging.logRequests: true` in config.yaml

**Graceful Shutdown:**
- Safe termination without dropping connections
- Abort all in-flight requests via AbortController
- Run registered teardown handlers
- Close HTTP server cleanly

### Protocol Adapter Details

**Transform Flow:**
- Inbound: Protocol Request → Transform → OpenAI-shaped IR → Core Gateway
- Outbound: Core Gateway → OpenAI-shaped IR → Transform → Provider Request
- Response: Provider Response → Transform → OpenAI-shaped IR → Transform → Protocol Response

**Canonical IR Structure:**
- OpenAI protocol serves as the canonical internal representation (hub format)
- All internal logic operates on OpenAI-shaped representations
- Enables adding new protocols without changing core logic
- Transformations handled in `src/adapters/transforms/` (no separate canonical directory)

**Protocol Support:**
- **Inbound:** OpenAI API, Anthropic API
- **Outbound:** OpenAI (built-in), Anthropic (built-in), Gemini (built-in), Cloudflare Workers AI (uses OpenAICompatibleAdapter with special factory logic and object-based credentials), and any custom OpenAI- or Anthropic-compatible endpoint configured with `baseUrl`
- **Custom Provider Types**: Custom providers can specify `type: "openai-compatible"` (default) or `type: "anthropic-compatible"` to indicate protocol compatibility
- **Special Protocol Features:**
  - Max tokens precedence (max_tokens > max_completion_tokens on OpenAI ingress)
  - Tools & multimodal normalization through OpenAI hub format
  - Reasoning content extraction via extractReasoningFromThinkBlocks setting
  - Unified reasoning effort levels (minimal, low, medium, high, xhigh, max)
  - SSE streaming normalization to OpenAI format

## Technology Stack

- **Runtime**: Node.js 24+ (LTS recommended)
- **Framework**: Express 5
- **Validation**: Zod 4
- **HTTP Client**: Undici 8
- **Logging**: LogTape 2
- **Testing**: Vitest 4, MSW 2, Supertest 7
- **Config**: YAML with js-yaml
- **Environment**: dotenv

## Key Design Principles

1. **Single Binary, Single Config**: One process, one YAML file, no database, no sidecar
2. **HTTP-status-driven Lifecycle**: Key state transitions based on upstream HTTP status codes
3. **Protocol Agnostic**: OpenAI as hub format with cross-protocol translation
4. **Pool-based Resilience**: Automatic failover and cooldown for high availability
5. **Configurable Routing**: Flexible key rotation strategies (round-robin vs fill-first) for different use cases
6. **Model Configuration Inheritance**: Provider-level defaults with model-level overrides for efficient configuration
7. **Observability First**: Per-request audit logs and operational telemetry
8. **Local-first**: Designed for local development workflows with remote provider integration
