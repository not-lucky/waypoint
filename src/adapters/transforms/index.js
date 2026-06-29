import { translateOpenAIToClaude } from './request/openaiToClaude.js';
import { translateOpenAIToGemini } from './request/openaiToGemini.js';
import { translateClaudeToOpenAIRequest } from './request/claudeToOpenai.js';

import { translateClaudeToOpenAI, translateClaudeChunkToOpenAI } from './response/claudeToOpenai.js';
import { translateGeminiToOpenAI, translateGeminiChunkToOpenAI } from './response/geminiToOpenai.js';
import { translateOpenAIToClaudeResponse } from './response/openaiToClaude.js';
import { mapGeminiStatusToType } from '../../domain/errors/geminiErrorTypes.js';

export const FORMATS = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  GEMINI: 'gemini',
};

/**
 * Translates a request payload from a source protocol format to a target provider format.
 * We use a "hub and spoke" translation architecture: everything routes through the
 * OpenAI schema as the central Unified format. This scales better as new APIs are added,
 * preventing N*M translation file combinatorics.
 *
 * @param {string} sourceFormat - The incoming request format (from FORMATS).
 * @param {string} targetFormat - The outgoing provider format (from FORMATS).
 * @param {Object} payload - The request body.
 * @returns {Object} Translated request body.
 */
export function translateRequest(sourceFormat, targetFormat, payload) {
  if (sourceFormat === targetFormat) {
    return payload;
  }

  // Phase 1: Translate to the hub format (OpenAI) if not already
  let hubRequest = payload;
  if (sourceFormat === FORMATS.ANTHROPIC) {
    hubRequest = translateClaudeToOpenAIRequest(payload);
  }

  // Phase 2: Translate from the hub format (OpenAI) to the target format
  if (targetFormat === FORMATS.OPENAI) {
    return hubRequest;
  }
  if (targetFormat === FORMATS.ANTHROPIC) {
    return translateOpenAIToClaude(hubRequest);
  }
  if (targetFormat === FORMATS.GEMINI) {
    return translateOpenAIToGemini(hubRequest);
  }

  throw new Error(`Unsupported request translation from ${sourceFormat} to ${targetFormat}`);
}

/**
 * Translates a response payload from a source provider format to a target client format.
 *
 * Like request translation, responses route through the OpenAI unified schema first
 * before emitting the final representation.
 *
 * @param {string} targetFormat - The desired client response format (from FORMATS).
 * @param {string} sourceFormat - The incoming provider response format (from FORMATS).
 * @param {Object} payload - The JSON response body.
 * @param {Object} [req] - The original request parameters (for context).
 * @returns {Object} Mapped response body.
 */
export function translateResponse(targetFormat, sourceFormat, payload, req = {}) {
  if (targetFormat === sourceFormat) {
    return payload;
  }

  // Phase 1: Translate to the hub format (OpenAI)
  let hubResponse = payload;
  if (sourceFormat === FORMATS.ANTHROPIC) {
    hubResponse = translateClaudeToOpenAI(payload, req);
  } else if (sourceFormat === FORMATS.GEMINI) {
    hubResponse = translateGeminiToOpenAI(payload, req);
  }

  // Phase 2: Translate from the hub format (OpenAI) to the target client format
  if (targetFormat === FORMATS.OPENAI) {
    return hubResponse;
  }
  if (targetFormat === FORMATS.ANTHROPIC) {
    return translateOpenAIToClaudeResponse(hubResponse);
  }

  throw new Error(`Unsupported response translation from ${sourceFormat} to ${targetFormat}`);
}

/**
 * Translates a streaming event chunk from a provider format to an OpenAI-shaped chunk.
 * Streaming chunks have to be treated individually since they bypass standard response
 * aggregation.
 *
 * @param {string} sourceFormat - The provider format (from FORMATS).
 * @param {Object} chunk - The parsed chunk/event data.
 * @param {string} chunkId - The stream session chunk identifier.
 * @param {Object} [req] - The original request.
 * @returns {Object|null} Mapped OpenAI stream chunk, or null if filtered.
 */
export const translateStreamChunk = (sourceFormat, chunk, chunkId, req = {}) => {
  if (sourceFormat === FORMATS.OPENAI) {
    return chunk;
  }
  if (sourceFormat === FORMATS.ANTHROPIC) {
    return translateClaudeChunkToOpenAI(chunk, chunkId, req);
  }
  if (sourceFormat === FORMATS.GEMINI) {
    return translateGeminiChunkToOpenAI(chunk, chunkId, req);
  }

  return null;
};

/**
 * Translates a normalized upstream error into the ingress protocol's native error shape.
 *
 * The hub format is OpenAI (`{ code, message, type, statusCode, upstreamBody, ... }`).
 * Anthropic and Gemini errors are flattened to that hub shape first, then projected
 * into the target ingress format.
 *
 * Per the design decision: `code` is not translated. The raw upstream code is passed
 * through as the generic `upstreamCode` extra field, leaving the target format's
 * `code` slot free for the controller to populate from elsewhere if it wishes.
 *
 * @param {string} upstreamFormat - The provider's protocol (FORMATS).
 * @param {string} targetFormat - The ingress protocol (FORMATS.OPENAI or FORMATS.ANTHROPIC).
 * @param {Object} normalized - Output from `normalizeUpstreamError` (or any object with
 *   `{ message, statusCode, errorCode, errorType, retryAfterSeconds, provider, upstreamBody }`).
 * @returns {{
 *   code: string,
 *   type: string,
 *   message: string,
 *   statusCode: number,
 *   retryAfterSeconds: number|undefined,
 *   provider: string|undefined,
 *   upstreamCode: string|undefined,
 *   upstreamBody: any,
 * }}
 */
export function translateError(upstreamFormat, targetFormat, normalized) {
  const source = normalizeErrorToHub(upstreamFormat, normalized);

  if (targetFormat === FORMATS.OPENAI) {
    return {
      code: source.errorCode || 'upstream_error',
      type: source.errorType,
      message: source.message,
      statusCode: source.statusCode,
      retryAfterSeconds: source.retryAfterSeconds,
      provider: source.provider,
      upstreamCode: source.errorCode,
      upstreamBody: source.upstreamBody,
    };
  }

  if (targetFormat === FORMATS.ANTHROPIC) {
    return {
      code: source.errorCode || 'upstream_error',
      type: source.errorType || 'api_error',
      message: source.message,
      statusCode: source.statusCode,
      retryAfterSeconds: source.retryAfterSeconds,
      provider: source.provider,
      upstreamCode: source.errorCode,
      upstreamBody: source.upstreamBody,
    };
  }

  if (targetFormat === FORMATS.GEMINI) {
    return {
      code: source.errorCode || 'upstream_error',
      type: source.errorType,
      message: source.message,
      statusCode: source.statusCode,
      retryAfterSeconds: source.retryAfterSeconds,
      provider: source.provider,
      upstreamCode: source.errorCode,
      upstreamBody: source.upstreamBody,
    };
  }

  throw new Error(`Unsupported error translation from ${upstreamFormat} to ${targetFormat}`);
}

/**
 * @private
 * Flattens any protocol's normalized upstream error into the OpenAI-hub shape:
 * `{ errorCode, errorType, message, statusCode, retryAfterSeconds, provider, upstreamBody }`.
 */
function normalizeErrorToHub(upstreamFormat, normalized) {
  if (upstreamFormat === FORMATS.OPENAI) {
    return {
      errorCode: normalized.errorCode,
      errorType: normalized.errorType,
      message: normalized.message,
      statusCode: normalized.statusCode,
      retryAfterSeconds: normalized.retryAfterSeconds,
      provider: normalized.provider,
      upstreamBody: normalized.upstreamBody,
    };
  }

  if (upstreamFormat === FORMATS.ANTHROPIC) {
    // Anthropic shape: { type: 'error', error: { type, message } }
    const anthropicErr = normalized.upstreamBody?.error
      ?? (normalized.upstreamBody?.type === 'error' ? normalized.upstreamBody.error : normalized.upstreamBody)
      ?? {};
    return {
      errorCode: anthropicErr.type || normalized.errorType,
      errorType: anthropicErr.type || normalized.errorType || 'api_error',
      message: anthropicErr.message || normalized.message,
      statusCode: normalized.statusCode,
      retryAfterSeconds: normalized.retryAfterSeconds,
      provider: normalized.provider,
      upstreamBody: normalized.upstreamBody,
    };
  }

  if (upstreamFormat === FORMATS.GEMINI) {
    // Gemini shape: { error: { code, message, status } }
    const geminiErr = normalized.upstreamBody?.error || normalized.upstreamBody || {};
    const geminiType = mapGeminiStatusToType(geminiErr.status || normalized.errorType)
      || normalized.errorType
      || 'api_error';
    return {
      errorCode: geminiErr.code || normalized.errorCode,
      errorType: geminiType,
      message: geminiErr.message || normalized.message,
      statusCode: normalized.statusCode,
      retryAfterSeconds: normalized.retryAfterSeconds,
      provider: normalized.provider,
      upstreamBody: normalized.upstreamBody,
    };
  }

  // Unknown source format: passthrough.
  return {
    errorCode: normalized.errorCode,
    errorType: normalized.errorType,
    message: normalized.message,
    statusCode: normalized.statusCode,
    retryAfterSeconds: normalized.retryAfterSeconds,
    provider: normalized.provider,
    upstreamBody: normalized.upstreamBody,
  };
}
