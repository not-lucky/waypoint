# Sentinel Security Journal

This journal tracks critical security learnings, vulnerability patterns, and prevention strategies for the Waypoint codebase.

---

## [2026-06-05] Public Health Endpoint Information Leakage

### Vulnerability
The `/health` endpoint exposes internal key pool statuses, cooldown timestamps, and active providers. If exposed publicly without authentication alongside default wildcard CORS configuration, it allows malicious third-party sites visited by a developer to read this diagnostic information. This facilitates reconnaissance and targeted API key exhaustion attacks.

### Remediation
- Require client token authentication by attaching `authMiddleware` directly to the `/health` route.
- Restrict cross-origin access by ensuring only clients possessing a valid API key/token can query the endpoint.
