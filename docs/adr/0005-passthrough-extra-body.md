# ADR 0005: Passthrough Extra Request Parameters (extraBody)

## Status

Accepted

## Context

Waypoint translates multiple inbound request formats to a canonical "hub" format (OpenAI). While this simplifies routing and fallback mechanics, it naturally strips provider-specific parameters that are not part of the standard OpenAI schema (e.g., OpenRouter's routing preferences, Anthropic's metadata, or Gemini's `google_search` capability).

Clients need a mechanism to pass provider-specific parameters through the proxy. However, doing so introduces security risks:
- Blindly passing client-supplied fields could allow clients to overwrite standard request parameters (like `model`, `messages`, or `stream`), bypassing routing rules or authentication barriers.
- Standard adapter-level configurations (like `google.thinking_config` for Gemini thinking models) could be accidentally overwritten by client-supplied fields of the same name if shallow merged.

## Decision

Implement a security-gated, configurable passthrough mechanism called `extraBody` that allows provider-specific parameters to be defined in configuration defaults or client payloads and safely merged into the outbound payloads.

### Design

1. **Security Model (Default-Deny)**:
   - A whitelist config option `allowedExtraBody` is introduced at the provider and model level.
   - Client-supplied `extraBody` parameters are ignored unless explicitly whitelisted in `allowedExtraBody`.
   - Wildcard (`*`) is supported but still protected by the standard key filter.

2. **Standard Key Protection**:
   - Standard parameters defined in `STANDARD_REQUEST_KEYS` (e.g. `model`, `messages`, `stream`, etc.) are explicitly rejected from `isKeyAllowed` inside `getFilteredExtraBody`.
   - This ensures clients cannot use `extraBody` to tamper with standard routing keys.

3. **Known Nested Containers Merge**:
   - `applyExtraBody` deep-merges specific known nested containers (`extra_body`, `metadata`).
   - This allows adapter-injected configurations (e.g., `google.thinking_config` for Gemini reasoning models) to coexist with client-supplied parameters (e.g., `google.google_search`).
   - All other keys are shallow-merged to align with standard expectations.

### Implementation

- Request validation schemas in `src/infrastructure/web/middleware/zodValidation.js` enforce that `extraBody` must be an object (`z.record(z.unknown()).optional()`) for both OpenAI and Anthropic formats.
- Configuration schemas in `src/config/providerValidator.js` validate `allowedExtraBody` and `extraBody`.
- Standard key filtration is applied in `src/domain/routing/transformer.js`.
- Outgoing payload merging is implemented in `src/adapters/outbound/shared/extraBody.js`.

## Consequences

### Positive

- **Flexibility**: Clients can leverage provider-specific features without custom Waypoint changes.
- **Security**: Default-deny whitelisting prevents arbitrary field injection, and standard key filtering prevents routing/auth bypasses.
- **Robustness**: Gemini reasoning models continue to function correctly even when clients pass other `extra_body` options.

### Negative

- **Maintenance**: The set of deep-merged nested containers (`extra_body`, `metadata`) is hardcoded and may need updates if new formats emerge.
- **Complexity**: Admins must configure `allowedExtraBody` for whitelisting.

## References

- Implementation plan for remediation of extraBody.
- Coexistence bug in Gemini thinking path.
