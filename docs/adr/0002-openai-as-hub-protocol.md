# ADR 0002: OpenAI as Hub Protocol

## Status

Accepted

## Context

Waypoint needs to support multiple ingress protocols (OpenAI and Anthropic) and multiple egress protocols (Gemini, Anthropic, OpenAI, Cloudflare Workers AI, and any custom OpenAI- or Anthropic-compatible endpoint configured with `baseUrl`). Each provider has its own API format with different request/response structures, error handling, and streaming protocols.

The challenge is to provide a unified internal representation that:
- Can handle all provider-specific features
- Minimizes translation complexity
- Maintains compatibility with client expectations
- Supports extensibility for new providers

## Decision

Use OpenAI protocol as the canonical "hub" format for internal representation.

### Design

- **Hub Format**: OpenAI protocol serves as the unified internal model
- **Ingress Translation**: All client requests (OpenAI or Anthropic) are translated to OpenAI format
- **Egress Translation**: OpenAI format is translated to provider-specific formats for upstream calls
- **Response Translation**: Provider responses are translated back to the client's original protocol format
- **Error Translation**: Upstream errors are normalized into the OpenAI error envelope, then projected to the ingress protocol

### Implementation

- Translation logic is centralized in `src/adapters/transforms/`
- Request transforms in `src/adapters/transforms/request/`
- Response transforms in `src/adapters/transforms/response/`
- Error envelope handling in `src/domain/errors/envelope.js`

### Special Handling

- **Max Tokens**: On OpenAI ingress, `max_tokens` takes precedence over `max_completion_tokens` when both are present
- **Tools & Multimodal**: Normalized through OpenAI as the hub format
- **Reasoning Content**: Supported through OpenAI's `reasoning_content` field
- **Streaming**: SSE events are normalized to OpenAI's streaming format

## Consequences

### Positive

- **Simplified Core**: Business logic works with a single format instead of N×M protocol combinations
- **Ecosystem Alignment**: OpenAI is the de facto standard, making it a natural choice
- **Feature Parity**: OpenAI's format is expressive enough to represent most provider features
- **Client Compatibility**: Most clients already speak OpenAI protocol

### Negative

- **OpenAI Bias**: Internal representation is optimized for OpenAI's feature set
- **Translation Overhead**: All requests go through translation layers even for OpenAI-to-OpenAI
- **Feature Loss**: Provider-specific features not representable in OpenAI format may be lost

### Mitigations

- Provider-specific fields can be preserved in extended metadata
- Translation overhead is minimal compared to network latency
- Regular review of provider-specific features for hub format inclusion

## Alternatives Considered

### Anthropic as Hub
- **Pros**: Anthropic has strong streaming support and Claude-specific features
- **Cons**: Less ecosystem adoption, fewer clients speak Anthropic natively

### Custom Internal Format
- **Pros**: Could be optimized for Waypoint's specific needs
- **Cons**: Reinventing the wheel, more translation complexity, no ecosystem benefits

### Per-Protocol Pipeline
- **Pros**: No translation overhead for same-protocol requests
- **Cons**: N×M complexity, code duplication, harder to maintain

## References

- OpenAI API documentation
- Anthropic API documentation
- Translation implementation in `src/adapters/transforms/`
