/**
 * @fileoverview Protocol-specific client error envelope and SSE formatters.
 *
 * `buildClientErrorEnvelope(args, targetFormat)` projects the upstream's `code`,
 * `type`, and `message` into the ingress protocol's native envelope shape (OpenAI or
 * Anthropic). The upstream code, type, and message are passed through verbatim.
 *
 * The SSE formatters serialize an already-shaped envelope at the controller boundary
 * (OpenAI ingress -> OpenAI-shape SSE, Anthropic ingress -> Anthropic-shape SSE).
 */

import { FORMATS } from '../../adapters/transforms/index.js';

/**
 * Builds the protocol-specific client envelope from a flat error descriptor.
 *
 * The returned shape always contains the upstream-supplied `message`,
 * `type`, and `code` verbatim. When `details` is supplied, the OpenAI
 * envelope exposes it under `error.details`. The Anthropic envelope does
 * not surface `param`/`details` because the Anthropic Messages API error
 * schema only supports `{ type, message }`.
 *
 * @param {Object} [descriptor={}] - Flat error descriptor.
 * @param {string} [descriptor.message='Request failed'] - Human-readable message.
 * @param {string} [descriptor.errorCode='upstream_error'] - Waypoint error code.
 * @param {string} [descriptor.errorType='api_error'] - Provider-style error type.
 * @param {string|null} [descriptor.param=null] - Optional parameter that caused the error (OpenAI).
 * @param {Object} [descriptor.details] - Optional structured details bag (OpenAI only).
 * @param {string} [targetFormat=FORMATS.OPENAI] - Target protocol ('openai' or 'anthropic').
 * @returns {Object} The envelope, shape depends on `targetFormat`.
 *
 * @example
 * buildClientErrorEnvelope(
 *   { message: 'Model missing', errorCode: 'validationError' },
 *   'openai',
 * );
 * // → { error: { message, type: 'api_error', param: null, code: 'validationError' } }
 *
 * @example
 * buildClientErrorEnvelope(
 *   { message: 'Model missing', errorCode: 'validationError' },
 *   'anthropic',
 * );
 * // → { type: 'error', error: { type: 'api_error', message } }
 */
export function buildClientErrorEnvelope(descriptor = {}, targetFormat = FORMATS.OPENAI) {
  const message = descriptor.message || 'Request failed';
  const errorCode = descriptor.errorCode || 'upstream_error';

  if (targetFormat === FORMATS.ANTHROPIC) {
    return {
      type: 'error',
      error: {
        type: descriptor.errorType || 'api_error',
        message,
      },
    };
  }

  return {
    error: {
      message,
      type: descriptor.errorType || 'api_error',
      param: descriptor.param || null,
      code: errorCode,
      ...(descriptor.details ? { details: descriptor.details } : {}),
    },
  };
}

/**
 * Formats an error envelope as OpenAI-compatible SSE frames.
 *
 * OpenAI's streaming protocol requires a `data: <json>\n\n` frame per
 * error event, followed by `data: [DONE]\n\n` to close the stream. The
 * `[DONE]` frame can be omitted when the controller will close the
 * underlying socket immediately after the error.
 *
 * @param {{ error: Object }} envelope - The OpenAI-shaped error envelope.
 * @param {boolean} [includeDone=true] - Whether to append the `[DONE]` sentinel frame.
 * @returns {string} The serialized SSE text.
 */
export function formatOpenAiSseError(envelope, includeDone = true) {
  const frames = [`data: ${JSON.stringify(envelope)}\n\n`];
  if (includeDone) frames.push('data: [DONE]\n\n');
  return frames.join('');
}

/**
 * Formats an Anthropic-compatible SSE error event from an envelope that is already in
 * Anthropic shape (i.e. produced by `buildClientErrorEnvelope(..., 'anthropic')`,
 * yielding `{ type: 'error', error: { type, message } }`). The envelope is serialized
 * verbatim — there is no re-wrap step.
 *
 * Anthropic's streaming protocol emits an `event: error` frame with a JSON
 * `data:` payload. Unlike OpenAI, Anthropic does NOT terminate the stream
 * with a `[DONE]` sentinel; clients are expected to close after the error.
 *
 * @param {{ type: 'error', error: Object }} envelope - The Anthropic-shaped error envelope.
 * @returns {string} The serialized SSE text (`event: error\ndata: {...}\n\n`).
 */
export function formatAnthropicSseError(envelope) {
  return `event: error\ndata: ${JSON.stringify(envelope)}\n\n`;
}
