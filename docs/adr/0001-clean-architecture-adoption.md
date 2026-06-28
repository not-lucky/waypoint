# ADR 0001: Clean Architecture Adoption

## Status

Accepted

## Context

The Waypoint project is a local LLM proxy and gateway that needs to:
- Support multiple upstream providers with different protocols
- Handle complex request/response translation between protocols
- Manage key pool lifecycle with sophisticated cooldown policies
- Provide observability through audit logging and metrics
- Maintain testability and modularity as the codebase grows

The initial implementation risked becoming tightly coupled between protocol handling, business logic, and infrastructure concerns.

## Decision

Adopt Clean Architecture principles with the following layer structure:

### Layer Structure

- **Adapters Layer** (`src/adapters/`)
  - Handle external interfaces and protocol-specific concerns
  - `inbound/`: OpenAI and Anthropic protocol request parsing
  - `outbound/`: Provider-specific HTTP communication (Gemini, Anthropic, OpenAI, etc.)
  - `transforms/`: Cross-protocol request/response translation

- **Application Layer** (`src/application/`)
  - Orchestrate business logic and use cases
  - `orchestrator.js`: UnifiedOrchestrator class for request orchestration (entry point, client disconnects, abort controller management)
  - `orchestrationEngine.js`: Outer fallback orchestration loop (fallback routing between providers/models)
  - `retry/`: Retry strategies and orchestration logic

- **Domain Layer** (`src/domain/`)
  - Core business entities and rules independent of external concerns
  - `errors/`: Error definitions and handling policies
  - `keys/`: Key pool and lifecycle management
  - `routing/`: Model resolution and routing strategies (cache, router, transformer)

- **Infrastructure Layer** (`src/infrastructure/`)
  - External system integration and technical concerns
  - `http/`: HTTP client utilities
  - `lifecycle/`: Process lifecycle and graceful shutdown
  - `logging/`: Logging integration and audit trails
  - `monitoring/`: Metrics collection
  - `web/`: Express app factory (createApp.js), HTTP server setup (server.js), service dependency wiring (wireServices.js), middleware, and routing

- **Utils Layer** (`src/utils/`)
  - Shared utilities that don't fit in other layers
  - `streaming/`: SSE parsing and stream accumulation

### Dependency Rules

- Dependencies point inward: Infrastructure → Adapters → Application → Domain
- Adapters depend on Application and Domain layers and act as the boundary between Infrastructure and core layers
- Domain layer has no dependencies on other layers
- External libraries are isolated to appropriate layers

## Consequences

### Positive

- **Testability**: Each layer can be tested in isolation with appropriate mocks
- **Modularity**: Changes to protocols (adapters) don't affect business logic (domain)
- **Maintainability**: Clear separation of concerns makes the codebase easier to navigate
- **Flexibility**: New providers or protocols can be added by extending adapters
- **Domain Clarity**: Core business rules are isolated in the domain layer

### Negative

- **Initial Complexity**: More directory structure and boilerplate than a simple layered approach
- **Learning Curve**: Team members need to understand Clean Architecture principles
- **Indirection**: Some operations require crossing multiple layers, which can feel verbose

### Mitigations

- Clear directory naming conventions and module boundaries
- Comprehensive documentation in AGENTS.md and CONTEXT.md
- Test coverage ensures layer interfaces remain stable
- Regular code reviews to maintain architectural integrity

## Alternatives Considered

### Simple Layered Architecture
- **Pros**: Simpler structure, less indirection
- **Cons**: Tighter coupling between layers, harder to test business logic in isolation

### MVC Pattern
- **Pros**: Familiar pattern for web applications
- **Cons**: Not well-suited for the complex protocol translation and orchestration logic

### Microservices
- **Pros**: Clear service boundaries
- **Cons**: Overkill for a single-binary local proxy, adds operational complexity

## References

- Clean Architecture by Robert C. Martin
- The original architectural restructuring commit: 4a97cb1
