/**
 * @fileoverview Passthrough client error envelope and SSE formatters.
 *
 * The envelope is a thin wrapper over the upstream's own error fields. The client's
 * `code`, `type`, and `message` mirror what the upstream sent; the optional `upstreamCode`
 * field carries the raw upstream string when the ingress protocol has no direct
 * equivalent (per the design decision to "Don't translate code, just pass upstreamCode
 * through as a generic extra field").
 *
 * The SSE formatters produce a translated envelope at the controller boundary
 * (OpenAI ingress -> OpenAI-shape SSE, Anthropic ingress -> Anthropic-shape SSE).
 */

/**
 * Builds the v1 client envelope from a flat error descriptor.
 *
 * Accepts either a structured args object OR a flat descriptor with the
 * fields produced by `buildFinalError` / `buildPoolUnavailableError` / `buildCancelledError`:
 *   { code, message, httpStatus, type, provider, retryAfterSeconds, upstreamBody }
 *
 * @param {Object|undefined} argsOrDescriptor
 * @returns {{ error: Object }}
 */
export function buildClientErrorEnvelope(argsOrDescriptor = {}) {
  const d = argsOrDescriptor || {};
  const statusCode = d.statusCode ?? d.httpStatus;
  const finalStatus = typeof statusCode === 'number' && statusCode >= 100 && statusCode < 600
    ? statusCode
    : 502;

  const error = {
    code: d.errorCode || d.code || 'upstream_error',
    message: d.message || 'Request failed',
    httpStatus: finalStatus,
  };

  const type = d.errorType || d.type;
  if (type) error.type = type;
  if (d.provider) error.provider = d.provider;
  if (d.retryAfterSeconds !== undefined) error.retryAfterSeconds = d.retryAfterSeconds;
  if (d.upstreamBody) error.upstreamBody = d.upstreamBody;

  return { error };
}

/**
 * Normalizes a stream failure into the v1 client envelope.
 *
 * @param {any} normalized
 * @returns {{ error: Object }}
 */
export function normalizeStreamFailure(normalized) {
  return buildClientErrorEnvelope({
    statusCode: normalized.statusCode,
    message: normalized.message,
    errorCode: normalized.errorCode,
    errorType: normalized.errorType,
    provider: normalized.provider,
    retryAfterSeconds: normalized.retryAfterSeconds,
    upstreamBody: normalized.upstreamBody,
  });
}

/**
 * Formats a v1 error envelope as OpenAI-compatible SSE frames.
 *
 * @param {{ error: Object }} envelope
 * @param {boolean} [includeDone=true]
 * @returns {string}
 */
export function formatOpenAiSseError(envelope, includeDone = true) {
  const frames = [`data: ${JSON.stringify(envelope)}\n\n`];
  if (includeDone) frames.push('data: [DONE]\n\n');
  return frames.join('');
}

/**
 * Formats a v1 error envelope as Anthropic-compatible SSE error event.
 *
 * @param {{ error: Object }} envelope
 * @returns {string}
 */
export function formatAnthropicSseError(envelope) {
  return `event: error\ndata: ${JSON.stringify({ type: 'error', error: envelope.error })}\n\n`;
}
