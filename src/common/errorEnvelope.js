/**
 * @fileoverview Client-facing error envelope construction and SSE formatting.
 * Builds the v1 client error response envelope and formats for SSE.
 */

import { normalizeUpstreamError } from './upstreamError.js';

/**
 * Builds the v1 client-facing error response envelope.
 *
 * @param {Object} error - Error descriptor with code, message, and optional fields.
 * @param {number} finalStatus - HTTP status code to return to the client.
 * @returns {{ error: Object }} v1 error envelope.
 */
export function buildClientErrorEnvelope(error, finalStatus) {
  return {
    error: {
      code: error.code ?? 'upstream_error',
      message: error.message ?? 'Request failed',
      httpStatus: finalStatus,
      ...(error.type ? { type: error.type } : {}),
      ...(error.provider ? { provider: error.provider } : {}),
      ...(error.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

/**
 * Normalizes a stream failure into the v1 client error envelope.
 *
 * @param {any} err - Caught stream error.
 * @param {string} provider - Provider name fallback.
 * @returns {{ error: Object }} v1 error envelope.
 */
export function normalizeStreamFailure(err, provider) {
  const normalized = normalizeUpstreamError(err, provider);
  return buildClientErrorEnvelope(
    {
      code: normalized.code,
      type: normalized.type,
      message: normalized.message,
      provider: normalized.provider,
      retryAfterSeconds: normalized.retryAfterSeconds,
    },
    normalized.httpStatus,
  );
}

/**
 * Formats a v1 error envelope as OpenAI-compatible SSE frames.
 *
 * @param {{ error: Object }} envelope - v1 error envelope.
 * @param {boolean} [includeDone=true] - Whether to append a [DONE] marker.
 * @returns {string}
 */
export function formatOpenAiSseError(envelope, includeDone = true) {
  const frames = [`data: ${JSON.stringify(envelope)}\n\n`];
  if (includeDone) {
    frames.push('data: [DONE]\n\n');
  }
  return frames.join('');
}

/**
 * Formats a v1 error envelope as Anthropic-compatible SSE error event.
 *
 * @param {{ error: Object }} envelope - v1 error envelope.
 * @returns {string}
 */
export function formatAnthropicSseError(envelope) {
  return `event: error\ndata: ${JSON.stringify({ type: 'error', error: envelope.error })}\n\n`;
}
