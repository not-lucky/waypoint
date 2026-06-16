/**
 * @fileoverview Barrel re-export for decomposed upstream error modules.
 * Maintains backward compatibility by re-exporting all functions from the
 * decomposed modules: errorPolicy, errorClassifier, transportErrors, upstreamError, errorEnvelope.
 */

// Re-export from errorPolicy.js
export {
  ERROR_CATEGORIES,
  BILLING_CODES,
  PERMISSION_CODES,
  RATE_LIMIT_CODES,
  SERVER_CODES,
  isRetryable,
  shouldCooldownKey,
  resolveLifecycleTier,
} from './errorPolicy.js';

// Re-export from errorClassifier.js
export {
  parseRetryAfter,
  classifyUpstreamError,
  resolveStreamErrorStatus,
} from './errorClassifier.js';

// Re-export from transportErrors.js
export {
  getClientHttpStatus,
  classifyTransportError,
} from './transportErrors.js';

// Re-export from upstreamError.js
export {
  UpstreamError,
  normalizeUpstreamError,
  createStreamUpstreamError,
  throwIfStreamErrorPayload,
  throwIfGeminiStreamError,
} from './upstreamError.js';

// Re-export from errorEnvelope.js
export {
  buildClientErrorEnvelope,
  normalizeStreamFailure,
  formatOpenAiSseError,
  formatAnthropicSseError,
} from './errorEnvelope.js';
