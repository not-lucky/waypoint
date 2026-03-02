/* eslint-disable max-classes-per-file, class-methods-use-this, no-unused-vars */

export class NotImplementedError extends Error {
  constructor(message = 'Not implemented') {
    super(message);
    this.name = 'NotImplementedError';
  }
}

/**
 * @typedef {Object} UnifiedMessage
 * @property {string} role - The role of the message sender (e.g. 'system', 'user', 'assistant')
 * @property {string} content - The text content of the message
 */

/**
 * @typedef {Object} UnifiedRequest
 * @property {string} provider - The target provider name
 * @property {string} model - The mapping path model name (e.g., 'gemini/gemini-2.5-pro')
 * @property {string} actualModelId - The actual model ID to pass to the upstream API
 *    (e.g., 'gemini-2.5-pro-preview-05-06')
 * @property {UnifiedMessage[]} messages - The message array
 * @property {number} [temperature] - Generation temperature
 * @property {number} [maxTokens] - Max tokens to generate
 * @property {boolean} [stream] - Whether to stream the response
 * @property {boolean} [thinkingEnabled] - Whether thinking is enabled
 * @property {number} [thinkingBudget] - The reasoning budget for reasoning models
 * @property {string} [thinkingLevel] - The thinking level ('low', 'medium', 'high')
 * @property {string} [reasoningEffort] - OpenAI-specific reasoning effort ('low', 'medium', 'high')
 * @property {string} [fallbackModel] - Fallback model identifier
 * @property {boolean} [isFallback] - Flag to prevent fallback loops
 */

/**
 * @typedef {Object} ChoiceMessage
 * @property {string} role - Message role (usually 'assistant')
 * @property {string} content - Message text content
 * @property {string|null} [reasoning_content] - Thinking/reasoning text if present
 */

/**
 * @typedef {Object} ResponseChoice
 * @property {number} index - Index of the choice
 * @property {ChoiceMessage} message - The response message
 * @property {string|null} finish_reason - Reason for completion (e.g., 'stop')
 */

/**
 * @typedef {Object} UsageInfo
 * @property {number} prompt_tokens - Tokens in prompt
 * @property {number} completion_tokens - Tokens generated
 * @property {number} total_tokens - Total tokens used
 */

/**
 * @typedef {Object} NormalizedResponse
 * @property {string} id - Output ID (starts with 'waypoint-')
 * @property {string} object - Object type ('chat.completion')
 * @property {number} created - Unix timestamp (seconds)
 * @property {string} model - Request model identifier
 * @property {ResponseChoice[]} choices - List of generated choices
 * @property {UsageInfo} usage - Token usage details
 */

/**
 * @typedef {Object} DeltaInfo
 * @property {string|null} content - Incremental content chunk
 * @property {string|null} reasoning_content - Incremental reasoning chunk
 */

/**
 * @typedef {Object} StreamChoice
 * @property {number} index - Choice index
 * @property {DeltaInfo} delta - The chunk delta info
 * @property {string|null} finish_reason - Completion reason
 */

/**
 * @typedef {Object} StreamChunk
 * @property {string} id - Output ID
 * @property {string} object - Object type ('chat.completion.chunk')
 * @property {StreamChoice[]} choices - Choice deltas
 */

/**
 * @typedef {Object} NormalizedError
 * @property {string} code - The mapped error code
 *    (e.g., 'upstream_rate_limited', 'quota_exhausted', 'upstream_error')
 * @property {string} message - Descriptive error message
 * @property {number} httpStatus - Target HTTP status to return to client (e.g., 502, 503)
 * @property {string} provider - The name of the provider where the error occurred
 * @property {number} [retryAfterSeconds] - Optional cooldown duration for 429 errors
 */

export class BaseProvider {
  /**
   * Generates a non-streaming completion.
   * @param {UnifiedRequest} req - The normalized internal request.
   * @param {string} apiKey - The upstream provider API key.
   * @returns {Promise<NormalizedResponse>}
   * @throws {NotImplementedError}
   */
  async generateCompletion(req, apiKey) {
    throw new NotImplementedError();
  }

  /**
   * Generates a streaming completion.
   * @param {UnifiedRequest} req - The normalized internal request.
   * @param {string} apiKey - The upstream provider API key.
   * @param {AbortSignal} signal - Signal to abort the stream.
   * @returns {AsyncIterable<StreamChunk>}
   * @throws {NotImplementedError}
   */
  async generateStream(req, apiKey, signal) {
    throw new NotImplementedError();
  }

  /**
   * Normalizes an upstream API error to a standard representation.
   * @param {any} error - The caught upstream error.
   * @returns {NormalizedError}
   * @throws {NotImplementedError}
   */
  normalizeError(error) {
    throw new NotImplementedError();
  }
}

export default BaseProvider;
