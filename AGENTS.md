# Repository Guidelines

Orientation document for AI engineering agents working in Waypoint. This file is the codebase-navigation index and convention reference; user-facing documentation lives in `README.md`.

## Project Overview

Waypoint is a lightweight local LLM proxy and gateway written in Node.js (ESM) with a layered Clean Architecture. It pools API keys across multiple upstream providers, exposes OpenAI- and Anthropic-compatible ingress, and normalizes the most common protocol mismatches (tool calls, reasoning, finish reasons, streaming) so client code can talk to one shape while the gateway fans out to many backends.

- **Stack** — Node `>=18` (ESM), Express 5, Zod 4, LogTape 2, MSW 2, Vitest 4, ESLint 10 flat config. No bundler, no TypeScript; runtime is plain `node src/index.js`.
- **Ingress protocols** — OpenAI-compatible (`/openai/v1` and `/openai`) and Anthropic Messages (`/anthropic/v1` and `/anthropic`); each has a dry-run prefix.
- **Upstream providers** — OpenAI-compatible, native Anthropic, native Gemini, plus user-defined custom providers with `baseUrl`. Provider selection is driven by model name via `resolveModel`.
- **Key lifecycle** — Per-provider key pools with HTTP-status-driven cooldowns. 401 / 403 retire the key permanently; 402 / 408 / 429 / 5xx apply a cooldown (429 uses exponential backoff via `baseSeconds * 2^consecutiveFailures` capped at `maxSeconds`); other 4xx and transport errors leave the key state unchanged.
- **Per-request debug** — Optional folder-per-request artefacts under `logging.requestLogPath` (default `./logs/requests`), driven by `logging.logRequests: true`. Headers are redacted on the client side only.
- **Observability** — Prometheus-format `/metrics` plus structured LogTape logs. `lifecycle_tier` is the only observability surface of the cooldown tier decision.

User-facing feature list, installation, and deployment: see `README.md`.

## Architecture & Data Flow

```
Ingress Validation          Protocol Controllers           Unified Service               Key Registry                Provider Adapters
(cors → json → metrics →    (auth → rateLimiter → zod      UnifiedOrchestrator →          KeyRegistry.getKey/          OpenAICompatibleAdapter /
 auth → rateLimiter → zod)  validateCompletionBody /       orchestrationEngine →          flagSuccess /               AnthropicAdapter /
                             validateAnthropicMessagesBody)  keyRotationLoop → streamGuard  flagFailure → cooldownTracker GeminiAdapter (custom
                                                                                                                        providers via factory)
```

Load-bearing modules and their roles:

- **Composition root** — `src/app/bootstrap.js` (loads YAML, configures logging, wires services, opens the listener, registers signal teardown).
- **DI factory** — `src/app/wireServices.js` (constructs the singleton `keyRegistry`, `providerFactory`, `unifiedOrchestrator`, both controllers, `modelCache`, `metricsCollector`; passes them through).
- **Express factory** — `src/app/createApp.js` (cors → JSON body parser → metrics → `/health` → `/metrics` → protocol routers → terminal `errorHandler`).
- **Protocol controllers** — `src/controllers/baseController.js` (`BaseController.executeRequest` at line 114 owns the lifecycle), `src/controllers/openaiController.js`, `src/controllers/anthropicController.js`.
- **Route mounting** — `src/routes/openai.js`, `src/routes/anthropic.js`, `src/routes/health.js`, `src/routes/metrics.js` (all mounted in `src/app/createApp.js`).
- **Orchestrator** — `src/services/unifiedOrchestrator.js` (`UnifiedOrchestrator.executeCompletion` at line 65; module-level `activeControllers` Set wired into the teardown registry).
- **Retry & fallback** — `src/services/orchestrationEngine.js` (`runOrchestrationLoop`), `src/services/keyRotationLoop.js` (`executeWithRetry`), `src/services/retryStrategy.js` (`buildFinalError`).
- **Stream guard** — `src/services/streamGuard.js` (`createStreamWithAbortGuard` flags success/failure as the stream finishes or aborts).
- **Key registry** — `src/registry/keyRegistry.js`, `src/registry/cooldownTracker.js`, `src/registry/keyObject.js`, `src/registry/keyPool.js`.
- **Provider adapters** — `src/providers/base.js` (`BaseProvider`), `src/providers/factory.js` (`ProviderFactory`), `src/providers/openai.js`, `src/providers/anthropic.js`, `src/providers/gemini.js` (with sub-modules under `src/providers/gemini/`), `src/providers/shared/openaiPayload.js` / `openaiResponse.js` / `openaiToolCalls.js`.
- **Transforms** — `src/transforms/index.js` (`translateRequest` / `translateResponse` / `translateStreamChunk`, `FORMATS = { OPENAI, ANTHROPIC, GEMINI }`); OpenAI is the canonical hub; `src/transforms/request/openaiToClaude.js`, `src/transforms/request/claudeToOpenai.js`, `src/transforms/response/openaiToClaude.js`, plus `src/transforms/shared/anthropicTools.js` for tool-call shape conversion.
- **Streaming primitives** — `src/streaming/sseParser.js` (`parseSSEStream`), `src/streaming/sseUtils.js` (`runSSEStream`, `startSSEStream`), `src/streaming/streamAccumulator.js` (merges tool-call deltas + reasoning), `src/streaming/thinkingBuffer.js` (state machine for `<thought>` tag boundaries).
- **Domain** — `src/domain/modelRouter.js` (`resolveModel`, WeakMap-cached), `src/domain/requestTransformer.js` (`transformRequest`, WeakMap-cached compiled model settings), `src/domain/modelCache.js` (`ModelCache` for `/models` listing).
- **Middleware** — `src/middleware/auth.js`, `src/middleware/rateLimiter.js`, `src/middleware/zodValidation.js`, `src/middleware/metricsMiddleware.js`, `src/middleware/dryRun.js`.
- **Errors** — `src/errors/envelope.js` (client envelope + SSE formatters), `src/errors/upstream.js` (`UpstreamError`, `normalizeUpstreamError` passthrough, `createStreamUpstreamError`), `src/errors/policy.js` (`decideKeyAction` / `isRetryable` / `resolveCooldownSeconds` / `resolveLifecycleTier`, all keyed on raw HTTP status).
- **Config** — `src/config/loader.js` (`ConfigLoader`), validators per section in `src/config/{gateway,client,logging,provider}Validator.js` and `src/config/validator.js`.
- **Logging** — `src/logging/logger.js` (LogTape setup), `src/logging/requestLogger.js` (`RequestLog`, per-request debug folder), `src/logging/requestLoggerUtils.js` (redaction), `src/logging/upstreamErrorLogMeta.js` (structured log fields for upstream errors).
- **Monitoring** — `src/monitoring/metricsCollector.js` (Prometheus text exporter).
- **Lifecycle** — `src/lifecycle/lifecycle.js` (signal handlers), `src/lifecycle/teardownRegistry.js` (ordered teardown).

## Key Directories

| Directory | Purpose |
| --- | --- |
| `src/app/` | Composition root: bootstrap, DI wiring, Express app factory. |
| `src/controllers/` | HTTP-facing protocol controllers; `BaseController` shared lifecycle. |
| `src/services/` | Request orchestration, key rotation, retry decisions, stream abort guarding. |
| `src/registry/` | API-key lifecycle, key pools, cooldown timers. |
| `src/providers/` | Provider adapters (OpenAI-compatible, Anthropic, Gemini) plus factory and shared OpenAI shape mappers; sub-modules under `src/providers/gemini/`. |
| `src/routes/` | Express routers for each ingress protocol plus health and metrics. |
| `src/middleware/` | Cross-cutting middleware: auth, rate limiting, Zod validation, dry-run, metrics. |
| `src/errors/` | Error taxonomy, classification rules, normalization, v1 client envelope. |
| `src/domain/` | Pure request transformation and routing. No I/O. |
| `src/logging/` | LogTape setup, per-request debug folder writer, log-meta helpers. |
| `src/config/` | YAML config loading, env interpolation, Zod-style validators per section. |
| `src/transforms/` | Hub-and-spoke translation between OpenAI / Anthropic / Gemini schemas for requests, responses, and tool calls. |
| `src/streaming/` | SSE parsing, stream accumulator, thinking-tag buffer, run-loop helper. |
| `src/monitoring/` | Prometheus-format metrics collector. |
| `src/lifecycle/` | Graceful shutdown: teardown registry and signal wiring. |
| `src/utils/` | Small shared helpers (`getLongestPrefixSuffix`, `NotImplementedError`). |
| `test/` | Vitest suites mirroring `src/`, plus `test/helpers/`, `test/fixtures/`, `test/integration/`, `test/lifecycle/`. |

## Development Commands

All commands assume the repo root as the working directory. The `ci` script is the canonical local pre-flight; it chains lint and test with echo markers.

```bash
# Run the full test suite (Vitest, single pass, CI mode)
npm test

# Run tests in interactive watch mode
npm run test:watch

# Run tests with v8 coverage (lcov + html + text reporters)
npm run coverage

# Local CI: lint (auto-fix) then test
npm run ci

# Lint with auto-fix; ESLint flat config
npm run lint

# Dev server with Node's --watch (restarts on file change)
npm run dev

# Production-style start
npm start
```

`vitest.config.js` injects the following `test.env` so test runs do not need a real `.env`: `OPEN_WEBUI_TOKEN=mock-webui-token`, `CODEX_AGENT_TOKEN=mock-codex-token`, `GEMINI_API_KEY_1=gemini-key-1`, `GEMINI_API_KEY_2=gemini-key-2`, `ANTHROPIC_API_KEY_1=anthropic-key-1`, `OPENAI_API_KEY_1=openai-key-1`, `WAYPOINT_CONFIG_PATH=config.example.yaml`. Tests require `WAYPOINT_CONFIG_PATH` to resolve to a valid YAML; if unset, Vitest falls back to `config.example.yaml`.

## Runtime & Tooling

- **Node** — `>=26.1.0` (declared in `package.json#engines.node`). ESLint gates `n/no-unsupported-features/node-builtins` to `>=26.1.0`.
- **Module system** — ESM (`"type": "module"`); `src/index.js` is plain Node ESM, loaded with `dotenv/config` and awaited only when run as the main module.
- **Package manager** — npm; lockfile is `package-lock.json`. CI uses `npm ci`.
- **Bundler / TS** — None. No `tsconfig`, no Vite/Rollup/webpack/esbuild config, no `.ts` files under `src/`.
- **HTTP** — Express `5.2.1`.
- **Validation** — Zod `4.4.3` (schemas in `src/middleware/zodValidation.js`).
- **Logging** — `@logtape/logtape 2.1.4` and `@logtape/file 2.1.4`.
- **Tests** — Vitest `4.1.8`, `@vitest/coverage-v8 4.1.8`, MSW `2.14.6`, supertest `7.2.2`.
- **Lint** — ESLint `10.5.0` flat config with `@eslint/js 10.0.1`, `eslint-plugin-import-x 4.16.2`, `eslint-plugin-n 18.1.0`, `globals 17.6.0`.
- **Other runtime deps** — `cors 2.8.6`, `dotenv 17.4.2`, `js-yaml 4.1.1`.
- **ESLint relaxations** (per-glob overrides) — `no-param-reassign` off for `src/registry/**/*.js` and `src/middleware/rateLimiter.js`; `no-await-in-loop` off for `src/services/*.js`, `src/lifecycle/teardownRegistry.js`, `src/services/streamGuard.js`; `class-methods-use-this` off for `src/providers/**/*.js`; `n/no-process-exit` off for `src/app/bootstrap.js`, `src/lifecycle/lifecycle.js`, `src/config/validationErrors.js`; `import-x/no-named-as-default-member` off for `src/config/loader.js`; `no-unused-vars` off for `src/app/bootstrap.js`, `src/logging/logger.js`, `src/logging/requestLoggerUtils.js`, `src/providers/anthropic.js`, `src/streaming/sseParser.js`, `test/config/configLoader.test.js`; `no-useless-assignment` off for `src/providers/anthropic.js`, `src/services/streamGuard.js`, `src/transforms/request/claudeToOpenai.js`. Test files relax `no-console`, `no-empty`, `no-plusplus`, and `n/no-unsupported-features/node-builtins`. Root configs relax import resolution and `n/no-unpublished-import`.
- **Docker** — `Dockerfile` is a single-stage `node:22-alpine` build, `EXPOSE 20128`, `CMD ["node", "src/index.js"]`. `docker-compose.yml` maps `20128:20128`, mounts `./config`, `./logs`, and `./.env` (read-only), sets `NODE_ENV=production`, and uses `restart: unless-stopped`.

## Code Conventions & Common Patterns

- **ESM only.** `import` / `export` throughout `src/`. Named exports exclusively; zero `export default` occurrences under `src/`. The only `export default` in the repo are `eslint.config.js`, `vitest.config.js`, and `test/globalTeardown.js`.
- **Naming** — camelCase for functions, PascalCase for classes and class-mirroring files, UPPER_SNAKE_CASE for module-level constants. 21 exported classes, ~37 exported functions, 9 exported UPPER_CASE constants. Logger instances are uniformly `const logger = getAppLogger('<category>')` across 15 source files.
- **File names** — camelCase-leaning, with PascalCase for files whose primary export is a class (e.g. `controllers/baseController.js`, `registry/keyRegistry.js`). Outliers where the filename is a category not a class: `providers/base.js` (exports `BaseProvider`), `providers/openai.js` (exports `OpenAICompatibleAdapter`), `providers/anthropic.js` (exports `AnthropicAdapter`), `providers/gemini.js` (exports `GeminiAdapter`), `errors/upstream.js` (exports `UpstreamError`). Inside `src/providers/gemini/`, files are camelCase: `geminiCompletion.js`, `geminiFormatter.js`, `geminiStandardStream.js`, `geminiStream.js`, `geminiThinkingStream.js`.
- **Errors** — The client envelope is built by `buildClientErrorEnvelope(args, targetFormat)` in `src/errors/envelope.js`. `targetFormat` selects the ingress protocol shape; the upstream's `message`, `code`, and `type` are passed through verbatim with these defaults: `message: 'Request failed'`, `code: 'upstream_error'`, `type: 'api_error'`.
  - **OpenAI target** — `{ error: { message, type, param: null, code, details? } }`. `param` defaults to `null`. `details` is only included when the caller passes it (currently only for validation errors).
  - **Anthropic target** — `{ type: 'error', error: { type, message } }`. `code` is not surfaced in the Anthropic shape (Anthropic's own envelope has no `code` field); the upstream code is preserved on the server-side normalized object and via `upstreamCode` in `translateError`. Validation `details` are not included for the Anthropic target (Anthropic's spec has no such field).
  - Stream failures use `BaseController.emitStreamError` with `formatOpenAiSseError` (emits `data: {JSON}\n\n` plus optional `data: [DONE]\n\n`) or `formatAnthropicSseError` (emits `event: error\ndata: {JSON}\n\n`); both formatters serialize the envelope verbatim with no re-wrap step.
  - **Gateway-originated `type` mapping** — For errors the gateway itself emits (auth, rate-limit, payload-too-large, terminal `errorHandler`, controller `handleError` when the error has no upstream `type`), the `errorType` is resolved from HTTP status via `statusToErrorType(status)` in `src/errors/httpErrorTypes.js`. The table follows the Anthropic error spec: `400 → invalid_request_error`, `401 → authentication_error`, `402 → billing_error`, `403 → permission_error`, `404 → not_found_error`, `413 → request_too_large`, `429 → rate_limit_error`, `500 → api_error`, `504 → timeout_error`, `529 → overloaded_error`. Unmapped statuses fall back to `'api_error'`. Upstream errors still pass through `errorObj?.status || errorObj?.type` verbatim via `parseUpstreamError` / `normalizeUpstreamError` / `createStreamUpstreamError`.
  - **Ingress format resolution** — `resolveIngressFormat(req)` in `src/middleware/ingressFormat.js` returns `'anthropic'` or `'openai'` based on `req.baseUrl` (the router mount path set by `app.use('/anthropic', ...)`). It is the single source of truth used by the auth, rate-limit, validation, and terminal `errorHandler` middleware, and by the protocol controllers' `handleError` (which uses the controller's `protocolName` instead, set in the constructor).
  - `normalizeUpstreamError` (`src/errors/upstream.js`) is a pure passthrough: the upstream's `message`, `code`, `type`, status, and body are preserved verbatim. There is no per-code classification table; transport failures (no status) are bucketed into `connect_timeout` / `read_timeout` / `tls_error` for logging only.
  - Cross-protocol error mapping is handled by `translateError(upstreamFormat, targetFormat, normalized)` (`src/transforms/index.js:138`). It projects the upstream error into the ingress protocol's native envelope while preserving the raw upstream `code` as `upstreamCode`. The 3 × 3 matrix (OpenAI / Anthropic / Gemini × OpenAI / Anthropic / Gemini) is unit-tested under `test/transforms/translateError.test.js`.
  - Key-lifecycle policy is HTTP-status-only via three predicates in `src/errors/policy.js`:
    - `decideKeyAction(statusCode)` — returns `'retire'` for 401 / 403, `'cooldown'` for 402 / 408 / 429 / 5xx, `'none'` for everything else (including undefined for transport).
    - `isRetryable(statusCode)` — true for 401 / 403 / 402 / 408 / 429 / 5xx / undefined.
    - `resolveCooldownSeconds({ statusCode, retryAfterSeconds, defaultSeconds, consecutiveFailures, baseSeconds, maxSeconds })` — prefers `retryAfterSeconds` when present; for 429 applies `baseSeconds * 2^(consecutiveFailures-1)` capped at `maxSeconds`; otherwise returns `defaultSeconds`.
  - `resolveLifecycleTier(statusCode)` returns the friendly log label (`retired` / `cooldown` / `no_action` / `transport`) used by `src/logging/upstreamErrorLogMeta.js`.
- **Key lifecycle** — HTTP-status-driven cooldowns (`src/registry/cooldownTracker.js:62-97`). The policy table is intentionally minimal:
  - 401 / 403 → retire (`key.exhausted = true`, never reactivated).
  - 5xx → cooldown with `gateway.cooldown.serverSeconds` (default 60s), or `Retry-After` if the upstream provided one.
  - 402 / 408 / 429 → cooldown. For 429 the backoff is exponential: `baseSeconds * 2^(consecutiveFailures-1)`, capped at `maxSeconds`. Retry-After wins when present and positive.
  - Other 4xx or transport failure (no status) → no key-state change. The key is considered healthy and the next request will pick a different key (or the same one if the pool has only one entry).
  - Decisions are made in `handleKeyFailure` (`src/registry/cooldownTracker.js`) which `keyRegistry.flagFailure` calls. `decideKeyAction` and `isRetryable` in `src/errors/policy.js` are the public entry points; the key lifecycle module enforces the action.
  - `cooldownDefaults.js` exports only `baseSeconds`, `maxSeconds`, and `serverSeconds`. `gatewayValidator.js` rejects any other `cooldown.*` keys.
- **Config** — Zod-validated in `src/config/loader.js`. `ConfigLoader.loadConfig` does `fs.readFileSync` + `js-yaml.load`, then recursive `interpolate` with regex `\$\{([A-Za-z0-9_]+)\}/g` (see `replaceEnvVars` / `getMissingEnvVar` in `src/config/configUtils.js`), then `structuredClone`, then `coerceNumericProperties`, then `validateConfig` (which delegates to `validateGateway`, `validateClients`, `validateLogging`, `ProviderValidator`). Structural failures call `logErrorAndExitOrThrow` (`src/config/validationErrors.js:5`), which logs fatal and `process.exit(1)` by default.
- **Logging** — `getAppLogger(category)` returns `getLogger(['waypoint', category])`. `configureLogging(config, testConfig)` (`src/logging/logger.js:141`) is invoked by bootstrap after YAML loads. Two formatters: `customJsonFormatter` and `customTextFormatter`. Per-request debug folder only materialises when `logging.logRequests: true`; the only redaction (in `requestLoggerUtils.js:67-80`) replaces `authorization`, `x-api-key`, `proxy-authorization` (case-insensitive) with `'[REDACTED]'` on the client request side only. Provider-side request headers and event-stream payloads are not redacted.
- **Streaming** — SSE handling in `src/streaming/`. `runSSEStream` (`src/streaming/sseUtils.js:26`) is the canonical run loop: it calls `startSSEStream`, iterates `for await (const chunk of response)`, and finalizes with `reqLog.finalize()` and `res.end()` in a `finally` block. Tool-call deltas are merged by index (`mergeToolCallDeltas` in `src/providers/shared/openaiToolCalls.js:4`). Reasoning/text tag parsing uses `ThinkingBuffer` and `getLongestPrefixSuffix`. Stream abort is observed in `res.on('close', ...)` and triggers `createStreamWithAbortGuard` (`src/services/streamGuard.js:89`).
- **DI** — Services are wired explicitly in `src/app/wireServices.js` and passed to controllers and the registry. There is no global service locator. Tests substitute adapters via `providerFactory.register(name, adapter)` (`src/providers/factory.js:61`) — see `test/app/wireServices.test.js`.
- **Async** — Top-level `await` is used in `src/index.js` (guarded by `process.argv[1] === fileURLToPath(import.meta.url)`). Everywhere else, async functions return promises and errors propagate to `BaseController.executeRequest`, which catches and routes them through `handleError`.
- **Performance idioms** (with exact locations):
  - WeakMap-cached compiled model settings: `compiledModelConfigCache` in `src/domain/requestTransformer.js:8` (set/read at lines 56 and 72). Same pattern in `src/middleware/auth.js:21` (`clientCache`) and `src/domain/modelRouter.js:7` (`resolutionCache`).
  - Rate limiter: `Symbol`-indexed sliding window with `copyWithin` compaction. `WINDOW_HEAD_INDEX` symbol at `src/middleware/rateLimiter.js:16`; `compactTimestampWindow` at line 113; amortization threshold `WINDOW_COMPACT_THRESHOLD = 64` at line 24.
  - Single-cached `now` per operation: `src/middleware/rateLimiter.js:233`, `src/registry/keyRegistry.js:194`, `src/services/retryStrategy.js:23`.
  - Frozen module-level sentinels: `EMPTY_ENTRIES` (`src/domain/requestTransformer.js:1`), `NOOP_LOG` (`src/logging/requestLogger.js:18`).
  - Declarative tables: the `gateway.cooldown` validator at `src/config/gatewayValidator.js:48-64` and the `decideKeyAction` decision table at `src/errors/policy.js:25-35`.

## Important Files

| Path | Role |
| --- | --- |
| `src/index.js` | Entry point. Loads `dotenv/config`, awaits `bootstrap()` when run as the main module. |
| `src/app/bootstrap.js` | Boot orchestrator. Loads YAML, configures logging, wires services, opens the listener, registers SIGINT/SIGTERM teardown. |
| `src/app/createApp.js` | Express app factory. CORS → JSON body parser → metrics → health/metrics routers → protocol routers → terminal error handler. |
| `src/app/wireServices.js` | Explicit DI factory for the singleton service graph. |
| `src/services/unifiedOrchestrator.js` | Public request entry; tracks in-flight `AbortController`s for graceful shutdown. |
| `src/services/orchestrationEngine.js` | Retry-with-fallback loop. |
| `src/services/keyRotationLoop.js` | Per-attempt key selection, error classification, and registry updates. |
| `src/services/streamGuard.js` | Stream abort/failure guard for `keyRegistry.flagSuccess` / `flagFailure`. |
| `src/registry/keyRegistry.js` | Per-provider key pool, success/failure bookkeeping, health stats. |
| `src/registry/cooldownTracker.js` | HTTP-status-driven cooldown application. 401 / 403 paths are the only ones that set `exhausted = true`. |
| `src/controllers/baseController.js` | Shared request lifecycle for protocol controllers. |
| `src/providers/base.js` | `BaseProvider`: shared fetch + timeout signal + error classification. |
| `src/providers/factory.js` | `ProviderFactory`: gemini / anthropic / OpenAI-compatible strategies. |
| `src/transforms/index.js` | Hub-and-spoke translator: `translateRequest`, `translateResponse`, `translateStreamChunk`, plus `translateError` for cross-protocol error projection. |
| `src/streaming/sseUtils.js` | Canonical SSE run loop (`runSSEStream`, `startSSEStream`). |
| `src/errors/envelope.js` | Protocol-specific client envelope shape + SSE error formatters. |
| `src/errors/upstream.js` | `UpstreamError`, `normalizeUpstreamError`, `createStreamUpstreamError`. |
| `src/errors/policy.js` | `decideKeyAction` / `isRetryable` / `resolveCooldownSeconds` / `resolveLifecycleTier`, all keyed on raw HTTP status. |
| `src/config/loader.js` | YAML + env interpolation + Zod validation. |
| `src/config/providerValidator.js` | Provider registry validation (reserved vs custom). |
| `src/logging/logger.js` | LogTape setup; `configureLogging`, `getAppLogger`, `flushLogs`. |
| `src/logging/requestLogger.js` | `RequestLog` class and `createRequestLog` factory. |
| `src/middleware/auth.js` | `authMiddleware`; resolves client profile via WeakMap-cached lookup. |
| `src/middleware/rateLimiter.js` | In-memory sliding-window rate limiter (Symbol-indexed). |
| `src/middleware/zodValidation.js` | Zod schemas and middleware for OpenAI and Anthropic request bodies. |
| `src/monitoring/metricsCollector.js` | Prometheus-format metrics. |
| `src/lifecycle/lifecycle.js` | `registerLifecycle`, `teardown`, `resetLifecycleState`. |
| `vitest.config.js` | Vitest config: setup file, global teardown, `test.env`, coverage thresholds. |
| `eslint.config.js` | Flat ESLint config with per-glob relaxations. |
| `package.json` | Project manifest: scripts, dependencies, engines. |
| `config.example.yaml` | Full config surface used by tests; documents the `${VAR}` env interpolation contract. |
| `Dockerfile`, `docker-compose.yml` | Container build and runtime. |
| `README.md` | User-facing documentation. |

## Module Map (every `.js` under `src/`)

### `src/app/`
- `bootstrap.js` — boot orchestrator. Loads YAML, configures LogTape, wires services, opens the listener, registers signal teardown.
- `createApp.js` — Express app factory. CORS, JSON parser, metrics, health/metrics routers, protocol routers, terminal error handler.
- `wireServices.js` — explicit DI factory; constructs `KeyRegistry`, `ProviderFactory`, `UnifiedOrchestrator`, both controllers, `ModelCache`, `MetricsCollector`.

### `src/controllers/`
- `baseController.js` — `BaseController` shared lifecycle (`executeRequest`, `handleError`, `emitStreamError`).
- `openaiController.js` — `OpenAIController`; OpenAI-shaped request/response.
- `anthropicController.js` — `AnthropicController`; native Anthropic SSE events.

### `src/services/`
- `unifiedOrchestrator.js` — public request entry; tracks in-flight `AbortController`s for graceful shutdown.
- `orchestrationEngine.js` — `runOrchestrationLoop`; retry-with-fallback across `fallbackModel`.
- `keyRotationLoop.js` — `executeWithRetry`; per-attempt key selection, classifier-driven registry updates.
- `retryStrategy.js` — `buildFinalError`, `isRetryable` integration.
- `streamGuard.js` — `createStreamWithAbortGuard`; flags success/failure on stream completion or abort.

### `src/registry/`
- `keyRegistry.js` — `KeyRegistry`; per-provider pool, success/failure bookkeeping, health stats.
- `cooldownTracker.js` — `handleKeyFailure`; HTTP-status-driven cooldown application. 401 / 403 are the only paths that set `exhausted = true`.
- `keyObject.js` — `KeyObject`; per-key state (`active`, `cooldownUntil`, `consecutiveFailures`, `exhausted`).
- `keyPool.js` — `createKeyPool`, `getKeyFromPool` (round-robin / fill-first), `findKeyInPool` (Map-backed for pools ≥ 10).

### `src/providers/`
- `base.js` — `BaseProvider`; shared fetch (`performFetch`), timeout signal, `parseUpstreamError`, `normalizeError`.
- `factory.js` — `ProviderFactory`; strategies: `gemini`, `anthropic` / `type: 'anthropic-compatible'`, OpenAI-compatible fallback.
- `openai.js` — `OpenAICompatibleAdapter`; OpenAI-shaped request and stream.
- `anthropic.js` — `AnthropicAdapter`; native Anthropic SSE; emits OpenAI-shaped chunks via `translateStreamChunk`.
- `gemini.js` — `GeminiAdapter`; delegates to `src/providers/gemini/geminiCompletion.js` and `geminiStream.js`.
- `gemini/geminiCompletion.js` — non-stream Gemini path; branches on `reasoningSupported` for OpenAI-compat or native `generateContent`.
- `gemini/geminiStream.js` — streaming Gemini path; selects `geminiStandardStream.js` or `geminiThinkingStream.js`.
- `gemini/geminiStandardStream.js`, `gemini/geminiThinkingStream.js` — per-mode stream processors.
- `gemini/geminiFormatter.js` — `getThinkingLevel`, `extractThoughtTags`.
- `shared/openaiPayload.js` — `buildOpenAIChatPayload`; canonical token-limit precedence logic.
- `shared/openaiResponse.js` — `mapOpenAICompletionResponse`, `mapOpenAIStreamChunk`, `extractReasoningText`, `resolveReasoningEffort`.
- `shared/openaiToolCalls.js` — `mergeToolCallDeltas` (merge by `index`).

### `src/routes/`
- `openai.js` — `createOpenaiRouter`; auth + rateLimit + `GET /models` + `POST /chat/completions` (validated).
- `anthropic.js` — `createAnthropicRouter`; auth + rateLimit + `GET /models` + `POST /messages` (validated).
- `health.js` — `createHealthRouter`; single `GET /` against the key registry.
- `metrics.js` — `createMetricsRouter`; single `GET /` calling `syncKeyPoolMetrics` + `metricsCollector.toPrometheusText()`.

### `src/middleware/`
- `auth.js` — `authMiddleware`; `Authorization: Bearer` or `x-api-key`; client profile via WeakMap cache.
- `rateLimiter.js` — `rateLimiter`; Symbol-indexed sliding window; `clientWindows`, `rateLimiterIntervals`, `getClientWindowActiveTimestamps`, `resetRateLimiter`.
- `zodValidation.js` — `completionSchema`, `anthropicMessagesSchema`, `validateCompletionBody`, `validateAnthropicMessagesBody`.
- `metricsMiddleware.js` — `createMetricsMiddleware(collector)`; measures `waypoint_requests_total` and `waypoint_request_duration_seconds`.
- `dryRun.js` — `dryRunMiddleware`; sets `req.isDryRun = true`.

### `src/errors/`
- `envelope.js` — `buildClientErrorEnvelope`, `formatOpenAiSseError`, `formatAnthropicSseError`.
- `upstream.js` — `UpstreamError`, `normalizeUpstreamError`, `createStreamUpstreamError`, `throwIfStreamErrorPayload`.
- `policy.js` — `decideKeyAction`, `isRetryable`, `resolveCooldownSeconds`, `resolveLifecycleTier`. Pure functions over the raw HTTP status; no code classification.

### `src/domain/`
- `modelRouter.js` — `resolveModel`; `modelId` → `(provider, actualModelId, modelConfig, fallbackModel)`; WeakMap-cached.
- `requestTransformer.js` — `transformRequest`, `applyModelConfigToRequest`; WeakMap-cached compiled model settings.
- `modelCache.js` — `ModelCache`; served at `GET /models`.

### `src/logging/`
- `logger.js` — `configureLogging`, `getAppLogger`, `flushLogs`, `customJsonFormatter`, `customTextFormatter`.
- `requestLogger.js` — `RequestLog` (per-request debug folder), `createRequestLog` (returns `NOOP_LOG` when `logRequests` is off).
- `requestLoggerUtils.js` — `redactHeaders`, `safeTimestamp`, `shortId`.
- `upstreamErrorLogMeta.js` — `buildUpstreamErrorLogFields`; surfaces `lifecycle_tier` in structured logs.

### `src/config/`
- `loader.js` — `ConfigLoader`; `fs.readFileSync` + `js-yaml.load` + recursive `interpolate` + `coerceNumericProperties` + `validateConfig`.
- `validator.js` — `validateConfig`; delegates to per-section validators.
- `gatewayValidator.js`, `clientValidator.js`, `loggingValidator.js`, `providerValidator.js` — per-section Zod-style validation.
- `configUtils.js` — `RESERVED_PROVIDERS`, `replaceEnvVars`, `getMissingEnvVar`, `coerceToInt`.
- `cooldownDefaults.js` — `COOLDOWN_DEFAULTS`; per-tier second mappings.
- `configKeyUtils.js` — `filterValidKeys`.
- `validationHelpers.js` — `isPositiveInteger`, `isNonEmptyString`.
- `validationErrors.js` — `logErrorAndExitOrThrow`; fail-fast helper.

### `src/transforms/`
- `index.js` — `FORMATS`, `translateRequest`, `translateResponse`, `translateStreamChunk`, `translateError`.
- `utils.js` — `mapFinishReason`, `synthesizeMetadata`, `safeJsonParse`.
- `request/openaiToClaude.js`, `request/claudeToOpenai.js`, `request/openaiToGemini.js`, `request/geminiToOpenai.js` — request translation.
- `response/openaiToClaude.js`, `response/claudeToOpenai.js`, `response/openaiToGemini.js`, `response/geminiToOpenai.js` — response translation.
- `shared/anthropicTools.js` — Anthropic ↔ OpenAI tool-call and message conversion.

### `src/streaming/`
- `sseParser.js` — `parseSSEStream`, `parseSSEEventData`; handles multibyte UTF-8 splits.
- `sseUtils.js` — `startSSEStream`, `runSSEStream` (canonical SSE run loop).
- `streamAccumulator.js` — `StreamAccumulator`; merges tool-call deltas by `index` and reasoning text.
- `thinkingBuffer.js` — `ThinkingBuffer`; state machine for `<thought>` tag boundaries using `getLongestPrefixSuffix`.

### `src/monitoring/`
- `metricsCollector.js` — `MetricsCollector`; `incrementCounter`, `setGauge`, `observeHistogram`, `toPrometheusText`, `toJSON`. `syncKeyPoolMetrics` is called by the `/metrics` handler.

### `src/lifecycle/`
- `lifecycle.js` — `resetLifecycleState`, `teardown`, `registerLifecycle`; signal wiring.
- `teardownRegistry.js` — `TeardownRegistry` singleton; ordered teardown for in-flight requests, the rate limiter, and the HTTP server.

### `src/utils/`
- `stringUtils.js` — `getLongestPrefixSuffix`; streaming tag-boundary normalizer.
- `notImplementedError.js` — `NotImplementedError`; abstract-method marker.

## Common Tasks

### Add a new provider

1. Implement an adapter extending `BaseProvider` in `src/providers/<name>.js`. Override `generateCompletion` and `generateStream`. Reuse `BaseProvider.performFetch` and `parseUpstreamError` so classification and timeouts work uniformly.
2. Add a strategy branch in `src/providers/factory.js` (e.g. when `config.providers[name].type === '<name>-compatible'`). Otherwise the factory falls through to the OpenAI-compatible strategy.
3. Validate the provider structurally in `src/config/providerValidator.js`. If the provider is reserved (e.g. `gemini`, `anthropic`, `openai`) it MUST NOT carry a `type` field; custom providers MUST set `baseUrl`.
4. Add the new adapter's request/response shape to `src/transforms/index.js` (only if it speaks a non-OpenAI shape natively). OpenAI-compatible providers reuse `src/providers/shared/openaiPayload.js` and `openaiResponse.js`.
5. Add MSW handlers in `test/helpers/mswHandlers.js` if the new provider needs upstream HTTP stubs for integration tests; otherwise unit-test through `MockAdapter` in `test/helpers/mockAdapter.js`.

### Add a new client validation rule

1. Extend `validateClients` in `src/config/clientValidator.js`. New rules go through `logErrorAndExitOrThrow` with a clear message and the client index.
2. If the rule is structural (e.g. a new required field), update `src/middleware/auth.js` to populate `req.client` with the new field.
3. Add a unit test under `test/config/clientValidator.test.js` covering both pass and fail.

### Adjust the HTTP-status key-lifecycle policy

1. The decision table lives in `decideKeyAction` (`src/errors/policy.js:25-35`). To change the mapping (for example, retire on a new status) edit the `if` ladder there.
2. The retry policy lives in `isRetryable` (`src/errors/policy.js:42-55`). If the change should also affect retry behaviour, update both functions in lockstep.
3. The cooldown-duration policy lives in `resolveCooldownSeconds` (`src/errors/policy.js:70-87`). For 429 the formula is `baseSeconds * 2^(consecutiveFailures-1)`, capped at `maxSeconds`; for 5xx it falls back to `defaultSeconds` (typically `gateway.cooldown.serverSeconds`).
4. If you add a new key to `gateway.cooldown`, update the validator in `src/config/gatewayValidator.js:48-64` and the defaults in `src/config/cooldownDefaults.js`.
5. If the change produces a new `lifecycle_tier` label, ensure `src/logging/upstreamErrorLogMeta.js` still surfaces it correctly (it pulls from `resolveLifecycleTier`).
6. Add or update tests under `test/errors/upstreamErrors.test.js` (for the policy predicates) and `test/registry/keyRegistryFailures.test.js` / `test/registry/keyRegistry.test.js` (for the end-to-end registry behaviour).

### Debug a single request with the per-request folder

1. Set `logging.logRequests: true` and `logging.requestLogPath: <dir>` in `config.example.yaml` (or the active config).
2. Hit any `POST /openai*/chat/completions` or `POST /anthropic*/messages` route. The handler creates `RequestLog` via `createRequestLog` (`src/logging/requestLogger.js:266`).
3. The folder appears at `${requestLogPath}/${safeTimestamp(iso)}_${shortId}/` and contains `01_client_request.json` … `05_event_stream.jsonl` (see `Code Conventions & Common Patterns` for the exact writer of each file).
4. Headers in `01_client_request.json` are redacted (`authorization`, `x-api-key`, `proxy-authorization`); headers in `02_provider_request.json` are not.
5. If `logging.logRequests` is false, `createRequestLog` returns the frozen `NOOP_LOG` and the folder is never created.

### Use a dry-run route

1. Set `logging.logRequests: true` in config. (The dry-run routes short-circuit with HTTP 502 `dryRunDisabled` if it is off — see `Common Gotchas`.)
2. POST to `/dryrun/openai/v1/chat/completions` or `/dryrun/anthropic/v1/messages`. The `dryRunMiddleware` sets `req.isDryRun = true`.
3. `BaseController.executeRequest` runs through translation, model resolution, and request transformation but does not call the upstream. The dry-run response (`src/controllers/baseController.js:171-183`) returns `{ dryRun: true, message, request: { url, headers, body } }` so the operator can inspect the exact payload that *would* be sent.

### Add a new metric

1. Pick the metric family in `src/monitoring/metricsCollector.js`. Counters / gauges / histograms are all in one class.
2. If a new histogram needs a custom bucket layout, extend `DEFAULT_HISTOGRAM_BUCKETS` (or pass a custom array).
3. Wire the call site in the relevant service. `syncKeyPoolMetrics` (called by the `/metrics` handler) is the canonical place to surface key-pool health.
4. Test by hitting `GET /metrics` (auth required) and asserting the Prometheus text output.

### Wire a custom upstream through the OpenAI-compatible strategy

1. In `config.example.yaml`, add a custom provider:
   ```yaml
   providers:
     my-upstream:
       baseUrl: "https://my-upstream.example.com/v1"
       models:
         - id: "my-model"
   ```
2. `ProviderFactory` will match the OpenAI-compatible fallback strategy (the reserved-name check in `src/config/providerValidator.js` only blocks the three reserved names).
3. In your model id, prefix with the provider name so `resolveModel` (`src/domain/modelRouter.js:18`) routes correctly. The convention in `config.example.yaml` is `my-upstream:my-model` (or whatever the provider registry uses).
4. Hit the corresponding ingress route. The shared `OpenAICompatibleAdapter` will issue a normal OpenAI-shaped `POST {baseUrl}/chat/completions`.

## Testing & QA

- **Framework** — Vitest `4.1.8` (single pass via `npm test`, interactive via `npm run test:watch`).
- **Coverage** — `npm run coverage` runs the v8 provider with `text`, `html`, and `lcov` reporters. `src/index.js` is excluded. Thresholds (enforced): `lines: 80`, `branches: 70`. There are no `functions` or `statements` thresholds.
- **Layout** — Test files mirror `src/`: `test/app/`, `test/controllers/`, `test/domain/`, `test/errors/`, `test/logging/`, `test/middleware/`, `test/providers/`, `test/registry/`, `test/services/`, `test/streaming/`, `test/transforms/`, `test/config/`, `test/monitoring/`. Cross-cutting suites: `test/integration/` (mounts the full Express app end-to-end) and `test/lifecycle/` (graceful teardown sequencing and abort handling). New tests belong in the folder matching their domain (e.g. `test/services/<name>.test.js` for `src/services/<name>.js`).
- **Global setup / teardown** — `test/setup.js` lifts `process.setMaxListeners(30)` (to silence LogTape warnings) and calls `resetLifecycleState()` after each test. `test/globalTeardown.js` performs a best-effort recursive `rm` of `test/.tmp` at the end of a run.
- **Mock layer**:
  - **MSW** — `test/helpers/mswSetup.js` exposes `createMSWServer(...handlers)`, a thin wrapper over `msw/node` `setupServer`. `test/helpers/mswHandlers.js` provides `http.post` handlers for OpenAI `/chat/completions` covering completion, stream, rate-limit, mid-stream error, malformed SSE, and server error.
  - **`testServer`** — `test/helpers/testServer.js` is the app harness: `DEFAULT_TEST_ENV`, `tempDir` / `writeTempConfig` helpers, `withTestEnv`, `createTestApp` / `reloadTestApp`, `createDryrunTestApp` / `createModelConfigTestApp`, and an authed `supertest` agent.
  - **`MockAdapter`** — `test/helpers/mockAdapter.js` is a test double implementing the `BaseProvider` interface; tracks `callCount`, `streamCallCount`, `apiKeysUsed`, `lastApiKey`, `lastReq`, and an `errorToThrow`. `buildMockApp(config, configureFactory)` builds an inline-config app and delegates to `createTestApp`.
  - **`normalizeTestError`** — `test/helpers/normalizeTestError.js` normalises test/mock errors through the production classifier (`normalizeUpstreamError`). `makeHttpError` and `makeUpstreamError` are the canonical builders; prefer these over ad-hoc `err.status = N` shortcuts in test doubles.
- **CI** — `.github/workflows/ci.yml` runs `npm ci` then `npm run lint` then `npm test` on a Node matrix of `24, 26` for pushes and pull requests against `master`. The local `ci` script chains the same two commands with echo markers.

## Commit & Pull Request Guidelines

- **Commit format** — Conventional Commits: `<type>(<scope>): <description>`. Types observed in history: `feat`, `fix`, `ref`, `chore`. Scope is typically the module or layer (e.g. `errors`, `ci`, `metrics`). Breaking changes use a `!` suffix after the type/scope (e.g. `ref!: simplify error handling`). Keep the subject line under ~72 chars and in the imperative mood.
- **Pre-commit checks** — Run `npm run ci` locally before pushing. It chains `npm run lint` (ESLint flat config, auto-fix) then `npm test` (Vitest single pass). CI in `.github/workflows/ci.yml` runs `npm ci`, `npm run lint`, `npm test`; both `lint` and `test` must be green.
- **Pull requests** — Target `master`. The CI workflow triggers on pushes and PRs against `master` and exercises Node 24 and 26. PRs should keep coverage at or above the enforced thresholds (`lines: 80`, `branches: 70`, see `vitest.config.js`). No PR template exists in `.github/`; include a short summary of the why, link any related issue, and call out protocol-shape changes (ingress providers, error envelopes, streaming behaviour) explicitly so reviewers can spot client-visible regressions.

## Common Gotchas

- **Reserved provider names** — `gemini`, `anthropic`, `openai` (in `src/config/configUtils.js:1`) MUST NOT carry a `type` field; custom providers MUST set `baseUrl`. Enforced by `ProviderValidator` in `src/config/providerValidator.js`.
- **Dry-run routes require logging** — The `/dryrun/openai*` and `/dryrun/anthropic*` routes return `dryRunDisabled` (HTTP 502, `code: 'dryRunDisabled'`) when `logging.logRequests` is false. Set `logging.logRequests: true` to use dry-run, or set `logging.logRequests: false` and don't hit the dry-run routes. The dry-run middleware only sets `req.isDryRun = true`; behaviour is enforced downstream.
- **HTTP 429 → cooldown, with exponential backoff.** Every 429 is treated uniformly: the key is cooled down, with the duration equal to `Retry-After` when present and positive, otherwise `baseSeconds * 2^(consecutiveFailures-1)` capped at `maxSeconds`. Providers that surface quota exhaustion on 429 (`daily_tokens_exceeded` style) are not treated differently from RPM/TPM 429s — the upstream's own `code` and `message` are passed through to the client (see `src/errors/upstream.js`), and the key simply waits through the cooldown. If you need a different cooldown for quota-style 429s, change the config; the policy is not code-aware.
- **`max_tokens` precedence** — In `buildOpenAIChatPayload` (`src/providers/shared/openaiPayload.js:40-48`), `req.maxTokens` takes precedence over `clientParams.max_tokens`; the `clientParams.max_tokens` takes precedence over `clientParams.max_completion_tokens`; `max_completion_tokens` is deleted if `max_tokens` is set, and vice versa. This is the canonical place to inspect if OpenAI ingress token limits look wrong.
- **Per-request debug folder base path** — Defaults to `./logs/requests` (`src/logging/requestLogger.js:281`); folder naming is `${safeTimestamp(iso)}_${shortId}` where `safeTimestamp` replaces `:` with `-` and `shortId` is a 6-char hex slice of `Math.random()` (`src/logging/requestLoggerUtils.js:49,58`). The folder is only created when `logging.logRequests: true`.
- **ESLint `no-param-reassign` is off only in two places** — `src/registry/**/*.js` and `src/middleware/rateLimiter.js` (both at `eslint.config.js:65-74`). Every other source file enforces the rule, so a registry-style mutation outside those paths will fail lint.
- **Per-request debug files** — `01_client_request.json`, `02_provider_request.json`, `03_provider_response.json`, `04_client_response.json`, `05_event_stream.jsonl`. Stages 3 and 4 are overwritten with summary shapes on stream completion (`logProviderStreamSummary`, `logClientStreamSummary`). Stage 5 is written as `--- provider ---\n{events}\n--- client ---\n{events}`. Provider-side request headers and event-stream payloads are not redacted; only the client request headers are.
- **`name === 'openai'`** — `ProviderFactory` forces `baseUrl` to `https://api.openai.com/v1`. To use a different OpenAI-compatible upstream, register a custom provider with a different name and `baseUrl`.
- **AbortController tracking** — `UnifiedOrchestrator.activeControllers` is a module-level `Set<AbortController>`. The orchestrator registers a teardown hook that aborts every active controller on shutdown. Adding a new long-running async path that holds an `AbortController` should also register cleanup here, otherwise graceful shutdown leaks in-flight requests.
- **Tool-call merging by index** — Streaming tool-call deltas are merged by `index` (`src/providers/shared/openaiToolCalls.js:4`). Providers that omit `index` default to `0`, which means a single-tool stream works fine; a multi-tool stream that omits `index` will collapse onto slot 0.

---

User-facing documentation lives in `README.md`; this file is for AI engineering agents.
