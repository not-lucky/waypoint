import { translateOpenAIToClaude } from './request/openai-to-claude.js';
import { translateOpenAIToGemini } from './request/openai-to-gemini.js';
import { translateClaudeToOpenAIRequest } from './request/claude-to-openai.js';

import { translateClaudeToOpenAI, translateClaudeChunkToOpenAI } from './response/claude-to-openai.js';
import { translateGeminiToOpenAI, translateGeminiChunkToOpenAI } from './response/gemini-to-openai.js';
import { translateOpenAIToClaudeResponse } from './response/openai-to-claude.js';

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
export function translateStreamChunk(sourceFormat, chunk, chunkId, req = {}) {
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
}
