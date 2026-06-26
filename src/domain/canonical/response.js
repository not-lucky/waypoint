/**
 * @fileoverview Canonical Internal Representation (IR) of LLM responses.
 * Standardized Waypoint LLM response representation that serves as the hub format
 * for all protocol translations and provider interactions.
 * @module domain/canonical/response
 */

/**
 * @typedef {Object} ChoiceMessage
 * @property {string} role - The role of the message sender
 * @property {string} content - The message content
 * @property {string|null} [reasoning_content] - Optional reasoning/thinking content
 */

/**
 * @typedef {Object} ResponseChoice
 * @property {number} index - Choice index
 * @property {ChoiceMessage} message - The message content
 * @property {string|null} finish_reason - Reason for completion termination
 */

/**
 * @typedef {Object} UsageInfo
 * @property {number} prompt_tokens - Number of tokens in the prompt
 * @property {number} completion_tokens - Number of tokens in the completion
 * @property {number} total_tokens - Total tokens used
 */

/**
 * @typedef {Object} CanonicalResponse
 * @property {string} id - Response identifier
 * @property {string} object - Object type (e.g., 'chat.completion')
 * @property {number} created - Unix timestamp of creation
 * @property {string} model - Model identifier used
 * @property {ResponseChoice[]} choices - Array of response choices
 * @property {UsageInfo} usage - Token usage information
 */

/**
 * @typedef {Object} DeltaInfo
 * @property {string|null} content - Delta content
 * @property {string|null} reasoning_content - Delta reasoning content
 */

/**
 * @typedef {Object} StreamChoice
 * @property {number} index - Choice index
 * @property {DeltaInfo} delta - Delta information
 * @property {string|null} finish_reason - Reason for completion termination
 */

/**
 * @typedef {Object} CanonicalStreamChunk
 * @property {string} id - Chunk identifier
 * @property {string} object - Object type (e.g., 'chat.completion.chunk')
 * @property {StreamChoice[]} choices - Array of stream choices
 */

/**
 * Creates a canonical response object.
 *
 * @param {Object} params - Response parameters
 * @param {string} [params.id] - Response identifier
 * @param {string} [params.object] - Object type
 * @param {number} [params.created] - Creation timestamp
 * @param {string} [params.model] - Model identifier
 * @param {ResponseChoice[]} [params.choices] - Response choices
 * @param {UsageInfo} [params.usage] - Token usage
 * @returns {CanonicalResponse} Canonical response object
 */
export function createCanonicalResponse(params = {}) {
  return {
    id: params.id || '',
    object: params.object || 'chat.completion',
    created: params.created || Date.now(),
    model: params.model || '',
    choices: params.choices || [],
    usage: params.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Creates a canonical stream chunk object.
 *
 * @param {Object} params - Stream chunk parameters
 * @param {string} [params.id] - Chunk identifier
 * @param {string} [params.object] - Object type
 * @param {StreamChoice[]} [params.choices] - Stream choices
 * @returns {CanonicalStreamChunk} Canonical stream chunk object
 */
export function createCanonicalStreamChunk(params = {}) {
  return {
    id: params.id || '',
    object: params.object || 'chat.completion.chunk',
    choices: params.choices || [],
  };
}

/**
 * Validates that a response object meets the canonical structure requirements.
 *
 * @param {Object} res - Response object to validate
 * @returns {boolean} True if valid, false otherwise
 */
export function isValidCanonicalResponse(res) {
  if (!res || typeof res !== 'object') return false;
  if (!res.id || typeof res.id !== 'string') return false;
  if (!Array.isArray(res.choices)) return false;
  if (!res.usage || typeof res.usage !== 'object') return false;
  return true;
}
