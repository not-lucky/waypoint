# ADR 0004: Unified Error Envelope

## Status

Accepted

## Context

Waypoint needs to return errors to clients in a consistent format while:
- Preserving upstream error information for debugging
- Supporting multiple ingress protocols (OpenAI, Anthropic)
- Distinguishing between gateway, pool, and upstream errors
- Providing actionable information (retry timing, provider identification)

The challenge is that each provider has different error formats, and clients expect protocol-specific error shapes.

## Decision

Use a unified error envelope internally, then project to protocol-specific formats for clients.

### Client Envelope Structure

OpenAI-shaped ingress (and pre-routing errors such as CORS, body parser, validation):

```json
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "Rate limit exceeded.",
    "type": "rate_limit_error",
    "param": null
  }
}
```

Anthropic-shaped ingress:

```json
{
  "type": "error",
  "error": {
    "type": "api_error",
    "message": "Rate limit exceeded."
  }
}
```

### Field Semantics (OpenAI shape)

| Field | Required | Source | Purpose |
|-------|----------|--------|---------|
| `code` | Yes | Upstream or fallback (`upstream_error`) | Stable error identifier for clients |
| `message` | Yes | Upstream | Human-readable error description, copied verbatim |
| `type` | Yes | Upstream or status-derived | Provider-style error category |
| `param` | Yes | Gateway | Always `null` for upstream and pool errors; used for validation context |
| `details` | Gateway validation only | Validation | Optional array of field-level validation issues |

### Field Semantics (Anthropic shape)

| Field | Required | Source | Purpose |
|-------|----------|--------|---------|
| `type` | Yes | Gateway | Always `error` |
| `error.type` | Yes | Upstream or status-derived | Provider-style error category |
| `error.message` | Yes | Upstream | Human-readable error description, copied verbatim |

When the orchestrator computes a `Retry-After` value, it is also set on the HTTP response as a `Retry-After` header. The header carries transport-layer retry guidance; the body envelope is the stable protocol-level contract.

### Protocol Projection

- **OpenAI**: `{ error: { ... } }` - directly uses the envelope
- **Anthropic**: `{ type: "error", error: { ... } }` - wraps the envelope
- **Streaming**: Error frame in protocol-specific SSE format, then close stream

### Error Categories

- **Gateway Errors**: Pure gateway faults (no provider field)
- **Pool Errors**: Key pool management issues (provider field, no upstream code)
- **Upstream Errors**: Provider-originated errors (all fields populated)

### Security Constraint

Raw upstream response bodies are **never** returned as the root HTTP body. Upstream debugging detail stays in server-side logs only.

## Consequences

### Positive

- **Consistency**: All errors follow the same structure internally
- **Debugging**: Preserves upstream error information while standardizing format
- **Protocol Support**: Easy to add new ingress protocols
- **Security**: Prevents leaking sensitive upstream details
- **Actionability**: Clients get retry timing and provider identification

### Negative

- **Translation Overhead**: Errors must be transformed for each protocol
- **Information Loss**: Some provider-specific error fields may not map cleanly
- **Envelope Coupling**: Internal logic depends on envelope structure

### Mitigations

- Translation is fast compared to network latency
- Audit logs capture full upstream responses for debugging
- Envelope can be extended with optional fields for provider-specific data

## Alternatives Considered

### Per-Protocol Error Formats
- **Pros**: No translation, native error handling
- **Cons**: Inconsistent experience across protocols, harder to debug

### Pass-Through Errors
- **Pros**: Maximum information preservation
- **Cons**: Inconsistent formats, security risk, poor UX

### Minimal Error Format
- **Pros**: Simple, less data
- **Cons**: Lost debugging information, no actionability

## References

- Error envelope implementation in `src/domain/errors/envelope.js`
- Translation logic in `src/adapters/transforms/index.js`
- Per-provider error catalog in `src/domain/errors/`
