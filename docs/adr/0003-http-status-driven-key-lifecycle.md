# ADR 0003: HTTP-Status-Driven Key Lifecycle

## Status

Accepted

## Context

Waypoint manages pools of API keys for each provider to provide:
- Load balancing across multiple keys
- Automatic failover when keys fail
- Rate limit handling to avoid unnecessary requests
- Cost optimization by reusing healthy keys

The challenge is determining when a key should be:
- Rotated out for the current request
- Temporarily disabled (cooldown)
- Permanently removed (retired)
- Left unchanged for future use

## Decision

Base all key lifecycle decisions on the upstream HTTP status code, with no parsing of error message content.

### Status Code Mapping

| Upstream Status | Key Action | Cooldown Policy |
|-----------------|-------------|-----------------|
| 401 | Retire | None (permanent) |
| 403 | Retire | None (permanent) |
| 402 | Cooldown | Retry-After header or serverSeconds |
| 408 | Cooldown | Retry-After header or serverSeconds |
| 429 | Cooldown | Retry-After header or exponential backoff |
| 5xx | Cooldown | Retry-After header or serverSeconds |
| Other 4xx | None | No state change |
| Transport Failure | None | No state change |

### Cooldown Strategies

- **Exponential Backoff**: For 429 errors, cooldown doubles on consecutive failures (baseSeconds × 2^(n-1), capped at maxSeconds)
- **Retry-After Header**: Upstream-provided delay takes precedence when present
- **Server Default**: serverSeconds for server errors when no Retry-After
- **Zero Retry-After**: Treated as "retry immediately"

### Rationale

- **401/403**: Authentication/authorization failures indicate invalid credentials; retrying is futile
- **402/408/429/5xx**: Temporary issues that may resolve; cooldown prevents hammering unhealthy keys
- **Other 4xx**: Client request errors; key is healthy, request was malformed
- **Transport Failure**: Network issues; key health is unknown, don't penalize

## Consequences

### Positive

- **Simplicity**: No need to parse error messages across different providers
- **Reliability**: HTTP status codes are stable and well-defined
- **Performance**: Fast decision making without string parsing
- **Consistency**: Uniform behavior across all providers

### Negative

- **Coarse Granularity**: Can't distinguish between different types of 4xx errors
- **False Positives**: Some 4xx errors might indicate key issues (e.g., 413 for quota)
- **Provider Differences**: Some providers use non-standard status codes

### Mitigations

- Monitor for patterns where specific 4xx codes should trigger cooldown
- Provider-specific overrides can be added if needed
- Audit logs provide visibility into key lifecycle decisions

## Alternatives Considered

### Error Message Parsing
- **Pros**: More granular understanding of failure reasons
- **Cons**: Fragile (providers change error formats), complex, slow

### Machine Learning
- **Pros**: Could learn optimal key rotation strategies
- **Cons**: Overkill, requires training data, unpredictable

### User Configuration
- **Pros**: Maximum flexibility
- **Cons**: Burdens users with operational complexity

## References

- Implementation in `src/domain/errors/policy.js`
- Cooldown tracking in `src/domain/keys/cooldownTracker.js`
- Key lifecycle documentation in README.md
