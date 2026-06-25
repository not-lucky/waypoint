# Repository Guidelines

> Orientation document for AI coding agents. For the user-facing feature
> description, configuration reference, and operational guide, see
> [README.md](./README.md).

Use the fff MCP tools for all file search operations instead of default tools.

---

## Project Overview

Waypoint is a single-binary local LLM proxy/gateway. It accepts OpenAI- and
Anthropic-shaped HTTP requests, validates them, picks an API key from a
per-provider pool, forwards to the upstream provider, and returns a
provider-shaped response (OpenAI, Anthropic, or Gemini) to the client. It also
supports custom OpenAI/Anthropic-compatible providers via `baseUrl`.

The differentiating features are: HTTP-status-driven key lifecycle (401/403
retire; 402/408/429/5xx cooldown with optional `Retry-After` and exponential
backoff for 429), cross-protocol translation via a hub-and-spoke OpenAI-shaped
"unified" model, multimodal and tool/function calling, SSE streaming, reasoning
(`reasoning_content`) normalization, dry-run inspection, and Prometheus
metrics.

Layout is layered Clean Architecture:

```
HTTP request
  → middleware (auth, zod, rate-limit, dry-run flag, metrics)
    → controller (OpenAI / Anthropic)  ←→  transforms/ (request/response/error)
      → orchestrator (abort + client-disconnect)
        → orchestrationEngine (fallback loop)
          → keyRotationLoop (key rotation + retry)
            → provider adapter (gemini / anthropic / openai-compatible)
              → upstream HTTP
```

Every layer only depends on the layer below. Composition lives in
`src/app/wireServices.js`; instantiation of Express + routes lives in
`src/app/createApp.js`; process startup lives in `src/app/bootstrap.js`.

## Architecture & Data Flow

Entry chain: `src/index.js` → `bootstrap()` → `wireServices(config)` →
`createApp(config, services, logger)` → `app.listen(port)` →
`registerLifecycle(...)`.

| Layer | File(s) | Responsibility |
| --- | --- | --- |
| Bootstrap | `src/index.js`, `src/app/bootstrap.js` | Process entry, safety nets, undici dispatcher install, config load, log configure, listen, signal handlers |
| Composition | `src/app/wireServices.js` | Manual DI: instantiates `KeyRegistry`, `ProviderFactory`, `UnifiedOrchestrator`, `OpenAIController`, `AnthropicController`, `ModelCache`, `MetricsCollector` |
| HTTP wiring | `src/app/createApp.js` | CORS, JSON body parser, metrics middleware, `/health`, `/metrics`, `/openai` + `/anthropic` routers, error handler |
| Auth / limit | `src/middleware/{auth,rateLimiter,zodValidation,ingressFormat,dryRun,metricsMiddleware}.js` | Token check → populate `req.client`; sliding-window per-client 429; schema validation; dry-run flag; per-request histogram |
| Controller | `src/controllers/{baseController,openaiController,anthropicController}.js` | Translate ingress protocol → OpenAI hub, run orchestrator, stream or return; subclassed for OpenAI vs Anthropic egress |
| Orchestrator | `src/services/{unifiedOrchestrator,orchestrationEngine,keyRotationLoop,retryStrategy,streamGuard}.js` | Client-disconnect handling, fallback routing, per-key retry, stream abort guard |
| Domain | `src/domain/{modelRouter,requestTransformer,modelCache}.js` | Resolve `model` → `{provider, modelConfig}`; apply model defaults/overrides; cache unique model list |
| Registry | `src/registry/{keyRegistry,keyPool,keyObject,cooldownTracker}.js` | Per-provider key pool, round-robin/fill-first selection, HTTP-status-based lifecycle (retire / cooldown) |
| Providers | `src/providers/{base,factory,dispatcher,anthropic,openai,gemini}.js` + sub-dirs | Abstract `BaseProvider`; concrete adapters; strategy registry; shared undici keep-alive dispatcher |
| Transforms | `src/transforms/{index,utils}.js` + `request/`, `response/`, `shared/` | Hub-and-spoke request/response/error translation (OpenAI ↔ Anthropic ↔ Gemini); tool-call shape conversion; reasoning-effort normalization |
| Streaming | `src/streaming/{sseParser,sseUtils,streamAccumulator,thinkingBuffer}.js` | Stateful UTF-8-aware SSE parser; per-chunk accumulator; `<think>` block tagging |
| Errors | `src/errors/{envelope,upstream,policy,httpErrorTypes,geminiErrorTypes}.js` | `UpstreamError` class, `normalizeUpstreamError` (passthrough), status → key-action policy, HTTP/gemini type maps, protocol-specific envelope builders |
| Logging | `src/logging/{logger,requestLogger,requestLoggerUtils,upstreamErrorLogMeta}.js` | LogTape configure/sinks, per-request debug folder (5 files), URL/header redaction |
| Monitoring | `src/monitoring/metricsCollector.js`, `src/routes/metrics.js` | In-process counters/gauges/histograms; `/metrics` Prometheus text |
| Lifecycle | `src/lifecycle/{lifecycle,teardownRegistry}.js` | SIGINT/SIGTERM, teardown hook registry, hard-exit safety timeout |
| Config | `src/config/{loader,validator,gatewayValidator,clientValidator,providerValidator,loggingValidator,configUtils,configKeyUtils,cooldownDefaults,validationErrors,validationHelpers}.js` | YAML + `${ENV}` interpolation, fail-fast validation, per-section validators |
| Routes | `src/routes/{openai,anthropic,health,metrics}.js` | `express.Router()` factories (mounted by `createApp.js`) |

Request data flow (non-streaming):

```
router → auth → rateLimit → zodValidation → controller.handleCompletion
  → BaseController.executeRequest
    → createRequestLog (writes 01_client_request.json)
    → translateReq(body)         ← protocol-specific in controller
    → resolveModel(body.model)   ← src/domain/modelRouter.js
    → transformRequest(baseReq, resolved)
    → orchestrator.executeCompletion(unifiedReq, req, reqLog)
      → runOrchestrationLoop (handles fallback chain)
        → executeWithRetry (per provider)
          → keyRegistry.getKey(provider)        (round-robin / fill-first)
          → adapter.generateCompletion(req, apiKey, signal, reqLog)
            → performFetch (sanitize URL, redact headers, log 02_provider_request.json)
            → parseUpstreamError on !response.ok
            → parseSSEStream + mapOpenAICompletionResponse for non-stream
            → returns Unified Response
          → on success: keyRegistry.flagSuccess
          → on error: keyRegistry.flagFailure (retire / cooldown)
      → returns NormalizedResponse
    → translateRes(response) ← protocol-specific out
    → reqLog.logClientResponse (writes 04_client_response.json)
    → res.json(finalResponse)
```

Streaming differs at the response branch: the orchestrator wraps the adapter's
`AsyncGenerator<StreamChunk>` in a guard that monitors `AbortController.signal`,
and the controller drives the per-protocol SSE output
(`openaiController.handleStream` / `anthropicController.handleStreamingResponse`)
while writing per-chunk events to `05_event_stream.jsonl`.

The `Orchestrator.activeControllers` set (`src/services/unifiedOrchestrator.js:19`)
and the `teardownRegistry` (`src/lifecycle/teardownRegistry.js:67`) are the two
singleton registries the system uses for cross-cutting lifecycle. Both are
imported directly; there is no service locator.

## Key Directories

```
src/
  app/           Entry, composition, Express wiring.
  config/        YAML loader, validators, env interpolation, defaults.
  controllers/   Protocol controllers (OpenAI / Anthropic) over BaseController.
  domain/        Model resolution, model-config compilation, model cache.
  errors/        UpstreamError, envelope builders, status-based policy, Gemini status map.
  lifecycle/     Teardown registry, SIGINT/SIGTERM handling, graceful shutdown.
  logging/       LogTape setup, per-request debug folder, URL/header redaction.
  middleware/    auth, rateLimit (sliding window), zodValidation, ingressFormat, dryRun, metrics.
  monitoring/    In-process Prometheus metrics collector.
  providers/
    base.js              Abstract BaseProvider (fetch + parseUpstreamError + timeout signal).
    factory.js           Strategy-registered adapter factory.
    dispatcher.js        Shared undici keep-alive Agent (installed in bootstrap).
    anthropic.js         Anthropic Messages API adapter.
    openai.js            OpenAI-compatible adapter (default for custom providers).
    gemini.js            Gemini adapter (delegates to ./gemini/*).
    gemini/              Gemini non-stream + stream + thinking + formatter modules.
    shared/              openaiPayload, openaiResponse, openaiToolCalls.
  registry/      KeyObject, KeyPool, KeyRegistry, cooldownTracker.
  routes/        OpenAI, Anthropic, health, metrics express.Router factories.
  services/      Orchestrator + orchestrationEngine + keyRotationLoop + retryStrategy + streamGuard.
  streaming/     sseParser, sseUtils, streamAccumulator, thinkingBuffer.
  transforms/
    index.js, utils.js
    request/      openaiToClaude, openaiToGemini, claudeToOpenai.
    response/     openaiToClaude, claudeToOpenai, geminiToOpenai.
    shared/       anthropicTools (tool-call shape conversion).
  utils/         stringUtils (prefix/suffix overlap), notImplementedError.

test/
  app/                  bootstrap / createApp / wireServices tests.
  config/               configLoader, configValidation, configKeyUtils tests.
  controllers/          controllers.test.js.
  domain/               modelResolver, modelSettings, coerceNumericProperties tests.
  errors/               upstreamErrors tests.
  fixtures/             dryrunConfig.yaml.
  helpers/              mswSetup, mswHandlers, testServer, mockAdapter, normalizeTestError.
  integration/          di, dryrun, endpoints, errorApiV1, health, rateLimiting, fallbackRouting, cooldownRecovery, protocolRoutes, serverIntegration, upstreamErrorDebugFolder, cors.
  lifecycle/            abort, teardown.
  logging/              logger, requestLogging, upstreamErrorLogMeta.
  middleware/           auth, rateLimiter, zodValidation, dryRun, metrics.
  monitoring/           metricsCollector.
  providers/            baseProvider, dispatcher, anthropicAdapter, geminiAdapter, openaiCompatibleAdapter, openaiPayload, openaiToolCalls, providerFactory, geminiThinkingStream.
  registry/             keyRegistry, keyRegistryFillFirst, keyRegistryFailures, teardownRegistry.
  services/             orchestratorBasic, orchestratorEdgeCases, orchestratorFallback, orchestratorLogger, orchestratorRetry, retryExecutor.
  setup.js, globalTeardown.js.
  streaming/            streamControllerErrors, streaming, sseParser, sseUtils, streamAccumulator, thinkingBuffer.
  transforms/           translateError, anthropicTools, translators.
```

The `test/` tree mirrors `src/` (one test directory per source directory). There
is no co-location; tests live in `test/<area>/*.test.js`.

## Development Commands

All commands run from the repo root.

| Command | Effect |
| --- | --- |
| `npm test` | Run the full Vitest suite once (`vitest run`). |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run coverage` | Vitest with `@vitest/coverage-v8` (thresholds: 80% lines, 70% branches, source includes `src/**/*.js` excluding `src/index.js`; see `vitest.config.js`). |
| `npm run lint` | ESLint (`eslint . --fix`) with the flat config in `eslint.config.js`. |
| `npm run ci` | `lint` → log → `test` (used in `.github/workflows/ci.yml`). |
| `npm run dev` | `node --watch src/index.js` for local dev. |
| `npm start` | `node src/index.js`. |
| `WAYPOINT_CONFIG_PATH=path/to/config.yaml npm start` | Override the config path (also used in tests). |
| `docker compose up` | Build and run the published image (mounts `./config`, `./logs`, `./.env`). |

ESLint relaxations are per-glob in `eslint.config.js`. Notable per-glob
overrides: `no-param-reassign: off` for `src/registry/**` and
`src/middleware/rateLimiter.js`; `no-await-in-loop: off` for `src/services/*.js`,
`src/services/streamGuard.js`, and `src/lifecycle/teardownRegistry.js`;
`class-methods-use-this: off` for `src/providers/**`; `n/no-process-exit: off`
for `src/app/bootstrap.js`, `src/lifecycle/lifecycle.js`,
`src/config/validationErrors.js`; `no-unused-vars: off` for `bootstrap.js`,
`logging/logger.js`, `logging/requestLoggerUtils.js`, `providers/anthropic.js`,
`streaming/sseParser.js`, and `test/config/configLoader.test.js`;
`no-useless-assignment: off` for `providers/anthropic.js`,
`services/streamGuard.js`, `transforms/request/claudeToOpenai.js`;
`import-x/no-named-as-default-member: off` for `config/loader.js`. Tests relax
`no-unused-vars` (allow leading underscore), `no-empty`, `no-plusplus`,
`n/no-unsupported-features/node-builtins`.

## Runtime & Tooling

- **Node ≥ 24** (see `engines.node` in `package.json`; CI matrix runs Node 24
  and 26). Node 24 LTS is the recommended runtime; Node 26 is also supported
  and tested. The codebase uses Node 22+ features (`Promise.withResolvers`,
  `Array.prototype.toSorted`, `Object.groupBy`, `AbortSignal.any`,
  `AbortSignal.timeout`, `node:util.styleText`, `RegExp.escape`).
- **npm** (lockfile `package-lock.json` is committed; no other package manager
  is supported).
- **ESM only** — `"type": "module"` in `package.json`. All imports use
  explicit `.js` extensions (enforced by `import-x/extensions` in
  `eslint.config.js`).
- **Express 5** (`express` 5.2.1). Routes return `express.Router()` factories
  that take dependencies — never globals.
- **Zod 4** for both client ingress validation (`src/middleware/zodValidation.js`)
  and a parallel set of plain validators in `src/config/*` for the YAML config.
  The two systems are independent; config uses custom hand-written validators
  (`validateGateway`, `validateClients`, `validateLogging`,
  `ProviderValidator.validate`) that call `logErrorAndExitOrThrow` in
  `src/config/validationErrors.js`.
- **`undici` 8** for the shared keep-alive `Agent` (`src/providers/dispatcher.js`).
  The dispatcher is installed as the global `fetch` dispatcher in
  `bootstrap()` (after safety nets, before any HTTP work). Per the comment at
  `src/providers/dispatcher.js:2-17`, the test path (`createTestApp`) does NOT
  call `bootstrap()`, so MSW's `fetch` interception is unaffected.
- **`@logtape/logtape` 2** + **`@logtape/file` 2** for logging. Two-step
  configuration: synchronous bootstrap sink at module load
  (`src/logging/logger.js:46-70`) is replaced by the configured sinks after
  config load (`configureLogging()` in the same file).
- **Vitest 4** + **MSW 2** + **Supertest 7** + **`@vitest/coverage-v8` 4**.

## Code Conventions & Common Patterns

- **ESM, named exports only.** No `export default` for application modules
  (config files use it because the bundler expects a default). All import paths
  include `.js`.
- **Naming.** camelCase for files and functions (`keyRegistry.js`,
  `buildClientErrorEnvelope`); PascalCase for class names
  (`KeyRegistry`, `AnthropicAdapter`, `BaseProvider`); SCREAMING_SNAKE_CASE for
  exported constants (`RESERVED_PROVIDERS`, `DEFAULT_HISTOGRAM_BUCKETS`,
  `COOLDOWN_DEFAULTS`).
- **Loggers are created at module load** as
  `const logger = getAppLogger( 'subsystem' )`. `getAppLogger` is the only
  factory and is exported from `src/logging/logger.js:269`. Always log
  redacted/redactable structured fields (`buildUpstreamErrorLogFields` in
  `src/logging/upstreamErrorLogMeta.js`).
- **Dependency injection is explicit and constructor-based.** No service
  locator. All wiring happens in `src/app/wireServices.js`. Tests substitute
  adapters via `testServer.createTestApp` / `mockAdapter.MockAdapter`.
- **Errors flow through `normalizeUpstreamError`** (in
  `src/errors/upstream.js:160`). It is a passthrough: the upstream's
  `message`, `code`, and `type` are preserved verbatim. Classifier output
  drives the `KeyRegistry` (`decideKeyAction` in `src/errors/policy.js:47`);
  raw HTTP status does not.
- **Error envelope is protocol-specific.** `buildClientErrorEnvelope(args,
  targetFormat)` in `src/errors/envelope.js:21` projects an OpenAI-shaped
  envelope by default and an Anthropic-shaped `{ type: 'error', error: {...} }`
  envelope when `targetFormat === 'anthropic'`. Upstream `code`/`type`/
  `message` are passed through unchanged. Gateway-originated errors use
  `statusToErrorType` from `src/errors/httpErrorTypes.js` to derive the
  envelope `type` (Anthropic's spec: 429 → `rate_limit_error`, 401 →
  `authentication_error`, etc.).
- **Key lifecycle is HTTP-status-driven**, not tier-driven:
  - 401/403 → retire (permanent, never reactivates).
  - 402/408/429 → cooldown. 429 uses exponential backoff
    `baseSeconds * 2^(consecutiveFailures - 1)` capped at `maxSeconds`; 0
    Retry-After means "retry immediately"; non-zero Retry-After wins.
  - 5xx → cooldown (`serverSeconds` or `Retry-After` if present).
  - Other 4xx, transport failure → no key-state change.
  - See `src/registry/cooldownTracker.js:79-119` and
    `src/errors/policy.js:81-99`.
- **Provider strategies** register via `ProviderFactory.registerStrategy(...)`
  in `src/providers/factory.js:31-33`. Three default strategies match
  reserved names (`gemini`, `anthropic`, `openai`); custom providers fall
  through to the OpenAI-compatible strategy. Adding a strategy mutates
  `ProviderFactory.strategies` (a static array) at module load.
- **Hub-and-spoke translation.** Everything routes through OpenAI as the
  unified internal format. The transforms layer (`src/transforms/index.js`)
  exposes `translateRequest`, `translateResponse`, `translateStreamChunk`,
  `translateError`. Adding a new protocol means writing only the spokes
  (provider ↔ OpenAI), not N×M matrix combinations.
- **Performance idioms:**
  - WeakMap-keyed caches keyed by config references so the cache is GCed
    automatically when config is replaced:
    `src/middleware/auth.js:25` (`clientCache`),
    `src/domain/modelRouter.js:7` (`resolutionCache`),
    `src/domain/requestTransformer.js:8` (`compiledModelConfigCache`).
  - Sliding-window rate limiter with a `Symbol`-keyed `WINDOW_HEAD_INDEX` to
    avoid shifting the underlying array; compacts in place once
    `WINDOW_COMPACT_THRESHOLD = 64` expired entries accumulate.
    `src/middleware/rateLimiter.js:20,28,75-138`.
  - Single-cached `Date.now()` per request where used multiple times
    (e.g. `KeyRegistry.getHealthStats`).
  - Map-backed O(1) key lookup in pools ≥ `MAP_LOOKUP_THRESHOLD = 10`
    (`src/registry/keyPool.js:21,35-37`).
  - `Array.prototype.toSorted` instead of `[...arr].sort()` in the metrics
    hot path (`src/monitoring/metricsCollector.js:123`).
  - `AbortSignal.any([client, timeout])` and `Promise.withResolvers()` to
    avoid nested promise wrappers (`src/providers/base.js:223-226`,
    `src/lifecycle/lifecycle.js:67-76`).
  - Shared `undici` `Agent` with `keepAliveTimeout: 30s` and
    `keepAliveMaxTimeout: 60s`, `connections: 32` per origin, `pipelining: 1`
    (`src/providers/dispatcher.js`).
- **State management.** All state is in-process and in-memory. There is no
  external cache or persistence. `KeyRegistry` is the single source of truth
  for key health; `activeControllers` is the single source of truth for
  in-flight requests.
- **Async patterns.** Top-level `await` is used only in `src/index.js` (for
  `bootstrap()`). Other modules export `async` functions or use
  `for await (const chunk of stream)` for SSE iteration. `await` inside
  `for` loops is allowed in `src/services/*.js` and `streamGuard.js` (the
  retry loop is the canonical example).
- **File-level eslint disables.** Used sparingly for partial sections, e.g.
  `/* eslint-disable no-unused-vars */` at the top of
  `src/providers/base.js` and `src/transforms/response/claudeToOpenai.js`.

## Important Files

| File | Why it matters |
| --- | --- |
| `src/index.js` | Process entry. Only file using top-level `await`. Loads `dotenv/config` then calls `bootstrap()`. |
| `src/app/bootstrap.js` | Safety nets, undici dispatcher install, `ConfigLoader.loadConfig()`, `configureLogging()`, `wireServices()`, `createApp()`, `app.listen()`, `registerLifecycle()`. Sets `Error.stackTraceLimit = 5` to cut V8 allocation cost on retry storms. |
| `src/app/wireServices.js` | Single source of dependency wiring — all singletons instantiated here. Modify when adding a new collaborator. |
| `src/app/createApp.js` | Express setup. Order: CORS → JSON body parser → metrics → `/health` → `/metrics` → `/openai` + `/anthropic` (with `/dryrun/*` siblings) → terminal error handler. |
| `src/controllers/baseController.js` | Shared controller logic. `executeRequest` runs the controller pipeline. `handleError` and `emitStreamError` project errors into the ingress protocol's envelope. |
| `src/services/unifiedOrchestrator.js` | Top-level orchestrator. Adds `AbortController` to `activeControllers`, hooks `target.on('close')` to forward client disconnects, registers a teardown hook that aborts all in-flight requests on shutdown. |
| `src/services/orchestrationEngine.js` | Outer fallback loop. Detects infinite fallback cycles (returns 508 `infiniteFallbackLoop`). |
| `src/services/keyRotationLoop.js` | Per-provider retry loop. Picks key, dispatches to adapter, on success calls `keyRegistry.flagSuccess`; on error normalizes via `adapter.normalizeError`, applies `decideKeyAction`, returns `{ triggerFallback: true }` when `req.fallbackModel` is set. |
| `src/registry/keyRegistry.js` | Per-provider pool facade. `getKey`, `findKey`, `flagFailure`, `flagSuccess`, `getHealthStats` (used by `/health` and `/metrics`), `getAggregateKeyPoolStats`, `cleanup` (teardown). |
| `src/registry/cooldownTracker.js` | HTTP-status-driven lifecycle actions (`handleKeyFailure`, `handleKeySuccess`, `setCooldown`, `applyCooldown`, `computeRateLimitBackoff`). |
| `src/providers/base.js` | Abstract `BaseProvider` with `performFetch` (URL sanitization, header redaction, dry-run throw, timeout signal combination via `AbortSignal.any`, `parseUpstreamError` on `!response.ok`). Subclasses implement `generateCompletion` / `generateStream` / `normalizeError`. |
| `src/providers/factory.js` | `ProviderFactory.registerStrategy` / `get` / `register`. Three default strategies registered. |
| `src/providers/dispatcher.js` | Shared undici `Agent` (keep-alive 30s, max 60s, 32 connections per origin, pipelining 1). Installed in `bootstrap()`. |
| `src/middleware/auth.js` | `extractAuthToken` (Authorization Bearer > x-api-key), `authMiddleware(config)` populates `req.client` with the resolved client profile. |
| `src/middleware/rateLimiter.js` | Sliding-window per-client 429. Symbol-keyed head index. 5-min cleanup interval that drops clients idle for >1h. |
| `src/middleware/zodValidation.js` | Zod schemas for `completionSchema` (OpenAI) and `anthropicMessagesSchema`. `respondValidationError` builds the 400 envelope. |
| `src/transforms/index.js` | `FORMATS`, `translateRequest`, `translateResponse`, `translateStreamChunk`, `translateError`. Hub-and-spoke. |
| `src/errors/upstream.js` | `UpstreamError`, `normalizeUpstreamError` (passthrough), `parseRetryAfter` (RFC 7231), `throwIfStreamErrorPayload`, `createStreamUpstreamError`, `resolveStreamErrorStatus`. |
| `src/errors/policy.js` | `decideKeyAction` (status → `'retire' \| 'cooldown' \| 'none'`), `isRetryable`, `resolveCooldownSeconds` (Retry-After wins; 429 uses `base * 2^(n-1)` capped at `max`), `resolveLifecycleTier` (log-only). |
| `src/errors/envelope.js` | `buildClientErrorEnvelope(args, targetFormat)`, `formatOpenAiSseError`, `formatAnthropicSseError`. |
| `src/config/loader.js` | `ConfigLoader` class. `loadConfig` reads `process.env.WAYPOINT_CONFIG_PATH || 'config/config.yaml'`, parses YAML, deep clones via `structuredClone`, calls `interpolate` (env `${VAR}` substitution), then `coerceNumericProperties` (immutable integer coercion), then `validateConfig(coerced, false)`. |
| `src/config/validator.js` | Top-level `validateConfig` — calls gateway, clients, logging, provider validators in sequence. |
| `src/logging/logger.js` | LogTape setup. `configureLogging(config)` (async, post-config), early-boot `configureSync` for pre-config startup errors. `getAppLogger(category)` is the only factory. |
| `src/logging/requestLogger.js` | `RequestLog` writes 5 files per request: `01_client_request.json`, `02_provider_request.json`, `03_provider_response.json`, `04_client_response.json`, `05_event_stream.jsonl` (when `logging.logRequests: true`). No-op stub (`NOOP_LOG`) returned when disabled. |
| `src/lifecycle/lifecycle.js` | `registerLifecycle`, `teardown` (10-second safety timeout that calls `process.exit(1)`), `resetLifecycleState` (used by `test/setup.js` between tests). |
| `src/lifecycle/teardownRegistry.js` | Singleton `teardownRegistry` instance. Modules import it directly to add cleanup hooks (e.g. `rateLimiter` clears intervals; `UnifiedOrchestrator` aborts active controllers). |
| `src/monitoring/metricsCollector.js` | Counters/gauges/histograms. `syncKeyPoolMetrics(collector, registry)` is called by the `/metrics` route handler. |
| `config.example.yaml` | Authoritative reference for the YAML schema. Reserved provider names must NOT carry a `type`; custom providers MUST have `baseUrl`. `logging.logRequests: true` is required for dry-run to work. |
| `vitest.config.js` | Sets `WAYPOINT_CONFIG_PATH=config.example.yaml` and mock client env vars for tests. Coverage thresholds: 80% lines, 70% branches. |
| `eslint.config.js` | Flat config. Per-glob overrides documented above. |

## Testing & QA

- **Framework.** Vitest 4 with `passWithNoTests: true`, `silent: true`.
  `test/setup.js` sets `process.setMaxListeners(30)` and resets lifecycle state
  after each test (`resetLifecycleState`). `test/globalTeardown.js` removes
  `test/.tmp/`.
- **Test layout mirrors `src/`.** One directory per source module group. No
  co-location. Test files are `*.test.js` and import from
  `../src/<area>/<file>.js`.
- **Helpers (under `test/helpers/`):**
  - `mswSetup.js` — `createMSWServer(...handlers)` thin wrapper over
    `setupServer`.
  - `mswHandlers.js` — `openaiCompletionHandler`, `openaiStreamHandler`,
    `rateLimitHandler`, `midStreamErrorHandler`, `malformedSseHandler`,
    `serverErrorHandler`.
  - `testServer.js` — `createTestApp({ resetModules, ... })` builds an
    isolated app on `test/.tmp/`. Provides `tempDir`, `withTestEnv`,
    `buildDryrunConfig`, `buildModelConfigYaml`, `createDryrunTestApp`,
    `createModelConfigTestApp`, `authed(app, token)` for supertest auth
    header.
  - `mockAdapter.js` — `MockAdapter` test double implementing the
    `BaseProvider` interface (tracks call counts, keys used, last request).
    `buildMockApp` factory.
  - `normalizeTestError.js` — `normalizeTestError`, `makeHttpError`,
    `makeUpstreamError`. **Always** use these in test doubles instead of bare
    `err.status = N` shortcuts, so the production error path is exercised.
- **Patterns.**
  - Pure unit tests for transforms, domain, services (orchestrator) — no HTTP
    needed.
  - Integration tests boot the app via `createTestApp` and use `supertest`
    (`authed(app, token)`) to drive requests.
  - Provider tests stub upstream HTTP via MSW; this means `bootstrap()` is
    not called and the undici dispatcher is NOT installed.
  - Streaming tests feed pre-built `ReadableStream` bodies into the SSE
    parser/accumulator paths and assert on the resulting OpenAI-shaped
    chunks.
- **Coverage.** v8 provider, `text`/`html`/`lcov` reporters, source
  `src/**/*.js` excluding `src/index.js`, thresholds 80% lines / 70% branches
  in `vitest.config.js`.
- **Running.** `npm test` for one-shot. `npm run test:watch` for development.
  `npm run coverage` with the threshold gate. `npm run ci` runs `lint` then
  `test` (used by `.github/workflows/ci.yml`).
- **CI.** `.github/workflows/ci.yml` runs on `push` and `pull_request` to
  `master`, on a `ubuntu-latest` matrix of Node 24 and Node 26. Restricted
  `GITHUB_TOKEN` to read-only.

## Common Gotchas

- **Reserved provider names** (`gemini`, `anthropic`, `openai`) MUST NOT
  carry a `type` field — the type is implied by the name. Custom providers
  MUST set `baseUrl`. Both rules enforced by `ProviderValidator`
  (`src/config/providerValidator.js:40, 75-191`).
- **`logging.logRequests` must be `true` for dry-run.** If a request hits
  `/dryrun/...` while `logRequests` is false, `BaseController.executeRequest`
  returns `dryRunDisabled` (HTTP 502) without making the upstream call
  (`src/controllers/baseController.js:153-158`).
- **OpenAI ingress token precedence.** `max_tokens` wins over
  `max_completion_tokens` when both are present on the OpenAI ingress
  (`src/controllers/openaiController.js:23`,
  `src/providers/shared/openaiPayload.js:40-48`).
- **Two different 429s.** A 429 from the upstream triggers cooldown with
  exponential backoff (in seconds). A 429 from the local rate limiter returns
  immediately with `code: 'rateLimitExceeded'`. The classifier distinguishes
  them: the local one is set in
  `src/middleware/rateLimiter.js:265-269`; the upstream one is decided in
  `src/registry/cooldownTracker.js:103-115`.
- **Key cooldown vs. exhausted.** A 401/403 *retires* the key permanently;
  subsequent calls skip it. A 402/408/429/5xx *cools down* the key with a
  timer; the key reactivates when the timer expires
  (`src/registry/cooldownTracker.js:79-119`).
- **MSW vs. undici dispatcher.** `bootstrap()` installs the undici
  dispatcher as the global `fetch` dispatcher (`src/providers/dispatcher.js`).
  The test path (`testServer.createTestApp`) does NOT call `bootstrap()`, so
  MSW's fetch interception still works. Don't call `bootstrap()` from tests.
- **Anthropic SSE event ordering.** The Anthropic controller tracks
  `messageStartSent`, `activeBlockType`, and `activeToolMeta` to emit
  `message_start` → `content_block_start` → `content_block_delta` (×N) →
  `content_block_stop` → `message_delta` → `message_stop` events
  (`src/controllers/anthropicController.js:38-220`).
- **OpenAI reasoning is mirrored by OpenRouter** in both `reasoning` and
  `reasoning_details`; we read one of them, not both
  (`src/providers/shared/openaiResponse.js:13-30`).
- **No top-level `await` outside `src/index.js`.** All other modules export
  `async` functions or use `await` inside `for` loops (allowed in
  `src/services/*.js` and `streamGuard.js`).
- **`Error.stackTraceLimit = 5`** is set in `bootstrap()`. If you `new
  Error().stack` and expect 10+ frames, set the limit locally.
- **Two distinct logger configure passes.** Module-load-time
  `configureSync` (in `src/logging/logger.js:46-70`) wires a console sink at
  `info` level so startup errors are visible before YAML is loaded. The
  fully-configured async `configureLogging(config)` then runs after
  `ConfigLoader.loadConfig()` and replaces the sinks. Don't call
  `getAppLogger` before `bootstrap()` — it works, but you'll get the early
  sink with `info` floor.
- **Singleton mutations persist across tests.** `teardownRegistry`,
  `activeControllers`, `clientWindows`, `rateLimiterIntervals`, and the
  `ProviderFactory.strategies` array all persist across the Vitest worker.
  Tests touching these should call `teardownRegistry.clear()` /
  `resetRateLimiter()` / `resetLifecycleState()` (the `afterEach` in
  `test/setup.js` handles the last one).
- **API base URL trailing slash is stripped** in
  `src/providers/base.js:97` (`this.baseUrl = baseUrl?.replace(/\/$/, '') ??
  null`).
- **Test environment variables** in `vitest.config.js` set the
  `WAYPOINT_CONFIG_PATH` to `config.example.yaml` and pre-fill the expected
  `${ENV}` placeholders. If you add a new env var to a test fixture, set it
  in `vitest.config.js` too.

---

For user-facing documentation, configuration reference, and the API surface
description, see [README.md](./README.md).
