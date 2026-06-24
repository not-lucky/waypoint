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

import { FORMATS } from '../transforms/index.js';

/**
 * Builds the protocol-specific client envelope from a flat error descriptor.
 *
 * @param {Object|undefined} argsOrDescriptor
 * @param {string} [targetFormat=FORMATS.OPENAI]
 * @returns {Object}
 */
export function buildClientErrorEnvelope(argsOrDescriptor = {}, targetFormat = FORMATS.OPENAI) {
  const d = argsOrDescriptor || {};
  const message = d.message || 'Request failed';
  const errorCode = d.errorCode || d.code || 'upstream_error';

  if (targetFormat === FORMATS.ANTHROPIC) {
    return {
      type: 'error',
      error: {
        type: d.errorType || 'api_error',
        message,
      },
    };
  }

  return {
    error: {
      message,
      type: d.errorType || 'api_error',
      param: d.param || null,
      code: errorCode,
      ...(d.details ? { details: d.details } : {}),
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
