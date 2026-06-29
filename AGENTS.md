# Agent Guide for Waypoint

This file helps AI agents understand how to work effectively with the Waypoint codebase.

## Quick Start

- **Runtime**: Node.js 24+ (LTS recommended)
- **Test**: `npm test` (Vitest 4 with MSW 2 and Supertest 7)
- **Lint**: `npm run lint` (ESLint with flat config)
- **Dev**: `npm run dev` (node --watch src/index.js)
- **CI**: `npm run ci` (lint + test)

## Architecture

Waypoint follows **Clean Architecture** principles with clear layer separation:

- **Adapters** (`src/adapters/`) — External interfaces (protocols, providers, transforms)
- **Application** (`src/application/`) — Business logic orchestration (orchestrator, orchestrationEngine, retry)
- **Domain** (`src/domain/`) — Core entities and rules (errors, keys, routing [cache, router, transformer])
- **Infrastructure** (`src/infrastructure/`) — External systems (HTTP, lifecycle, logging, monitoring, web [createApp.js, server.js, wireServices.js, middleware/])
- **Utils** (`src/utils/`) — Shared utilities (streaming)

**Dependency rule**: Dependencies point inward (Infrastructure → Adapters → Application → Domain). Domain layer has no dependencies on outer layers.

## Domain Language

Before making changes, read `CONTEXT.md` to understand the project's ubiquitous language. Key concepts:

- **Gateway/Proxy**: Central service that fronts multiple LLM providers
- **Provider**: Upstream LLM service (Gemini, Anthropic, OpenAI, Cloudflare, etc.)
- **Key Pool**: Collection of API keys for load balancing and failover
- **Orchestrator**: UnifiedOrchestrator (entry point, client disconnects, abort controller management) and OrchestrationEngine (outer fallback loop between providers/models)
- **Hub Format**: OpenAI protocol used as canonical internal representation
- **Cooldown**: Temporary key unavailability based on HTTP status codes
- **Error Envelope**: Unified error format projected to protocol-specific shapes

## Working with This Codebase

### Code Style

- **Naming**: camelCase for source and test files
- **Module Structure**: Follow Clean Architecture layer boundaries
- **Dependencies**: Point inward, never from Domain to Infrastructure
- **Error Handling**: Use unified error envelope from `src/domain/errors/envelope.js`
- **Validation**: Zod schemas for request validation
- **Streaming**: SSE handling via `src/utils/streaming/`

### Key Files to Understand

- `src/index.js` — Entry point and bootstrap
- `src/infrastructure/web/createApp.js` — Express app factory
- `src/infrastructure/web/server.js` — HTTP server setup and graceful shutdown
- `src/infrastructure/web/wireServices.js` — Service dependency wiring
- `src/application/orchestrator.js` — UnifiedOrchestrator class for request orchestration
- `src/application/orchestrationEngine.js` — Outer fallback orchestration loop
- `src/domain/keys/keyRegistry.js` — Key pool and cooldown management
- `src/adapters/transforms/` — Cross-protocol translation
- `src/domain/errors/policy.js` — HTTP-status-driven key lifecycle rules

### Testing Guidelines

- **Framework**: Vitest 4 with MSW 2 for HTTP mocking
- **Structure**: Tests mirror `src/` directory structure
- **Integration**: Cross-cutting HTTP tests in `test/integration/`
- **Coverage**: Thresholds defined in `vitest.config.js`
- **Run**: `npm test` for one-shot, `npm run test:watch` for development

### Common Patterns

**Adding a new provider**:
1. Create outbound adapter in `src/adapters/outbound/<provider>/` (or use OpenAICompatibleAdapter for OpenAI-compatible endpoints)
2. Add formatter for request/response translation
3. Register the provider and mapping in `src/adapters/outbound/factory.js`
4. Add error codes to `src/domain/errors/envelope.js`

**Note on Cloudflare provider**: Cloudflare uses the OpenAICompatibleAdapter with special factory logic (see `src/adapters/outbound/factory.js`). It requires object-based credentials with both `apiKey` and `accountId` in the config.

**Modifying key lifecycle**:
1. Check policy in `src/domain/errors/policy.js`
2. Update cooldown tracking in `src/domain/keys/cooldownTracker.js`
3. Add tests for new status code handling
4. Update ADR 0003 if changing the approach

**Protocol translation changes**:
1. Update transforms in `src/adapters/transforms/`
2. Ensure error envelope projection in `src/adapters/transforms/index.js`
3. Test both request and response paths
4. Update ADR 0002 if changing hub format strategy

**Note on canonical models**: The OpenAI protocol serves as the canonical internal representation (hub format). Model transformations are handled through the transform functions in `src/adapters/transforms/` rather than a separate canonical directory.

**Note on routing components**: The routing system (`src/domain/routing/`) consists of:
- `router.js` — Model resolution and provider matching
- `transformer.js` — Applying model configuration to requests
- `cache.js` — Caching resolved model configurations

### Configuration

- **Config File**: YAML in `config/config.yaml` (override with `WAYPOINT_CONFIG_PATH`)
- **Environment**: `.env` file for API keys and tokens
- **Schema**: Zod validation in `src/config/` (validator.js, clientValidator.js, gatewayValidator.js, loggingValidator.js, providerValidator.js, configUtils.js, configKeyUtils.js, cooldownDefaults.js, validationHelpers.js, loader.js)
- **Example**: `config.example.yaml` is authoritative reference

### Observability

- **Audit Logs**: Per-request logs when `logging.logRequests: true`
- **Health**: `GET /health` returns pool and routing state
- **Metrics**: `GET /metrics` returns Prometheus text format
- **Logging**: LogTape integration in `src/infrastructure/logging/`

## Architectural Decisions

Past architectural decisions are documented in `docs/adr/`:

- **ADR 0001**: Clean Architecture adoption
- **ADR 0002**: OpenAI as hub protocol
- **ADR 0003**: HTTP-status-driven key lifecycle
- **ADR 0004**: Unified error envelope

When proposing architectural changes, consider creating a new ADR to document the decision.

## Development Workflow

1. **Read CONTEXT.md** to understand domain language
2. **Check relevant ADRs** for architectural context
3. **Follow Clean Architecture** layer boundaries
4. **Write tests first** (TDD when appropriate)
5. **Run lint and tests** before committing
6. **Update documentation** if domain concepts change

## Getting Help

- **Domain terminology**: See `CONTEXT.md`
- **Architecture decisions**: See `docs/adr/`
- **API documentation**: See `README.md`
- **Configuration reference**: See `config.example.yaml`
