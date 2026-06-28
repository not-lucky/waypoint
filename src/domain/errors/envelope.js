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
 * @param {Object} descriptor
 * @param {string} [descriptor.message]
 * @param {string} [descriptor.errorCode]
 * @param {string} [descriptor.errorType]
 * @param {string} [descriptor.param]
 * @param {Object} [descriptor.details]
 * @param {string} [targetFormat=FORMATS.OPENAI]
 * @returns {Object}
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
 * Formats an Anthropic-compatible SSE error event from an envelope that is already in
 * Anthropic shape (i.e. produced by `buildClientErrorEnvelope(..., 'anthropic')`,
 * yielding `{ type: 'error', error: { type, message } }`). The envelope is serialized
 * verbatim — there is no re-wrap step.
 *
 * @param {{ type: 'error', error: Object }} envelope
 * @returns {string}
 */
export function formatAnthropicSseError(envelope) {
  return `event: error\ndata: ${JSON.stringify(envelope)}\n\n`;
}
