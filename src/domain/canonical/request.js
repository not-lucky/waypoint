/**
 * @fileoverview Canonical Internal Representation (IR) of LLM requests.
 * Standardized Waypoint LLM request representation that serves as the hub format
 * for all protocol translations and provider interactions.
 * @module domain/canonical/request
 */

/**
 * @typedef {Object} CanonicalMessage
 * @property {string} role - The role of the message sender (e.g., 'user', 'assistant', 'system')
 * @property {string} content - The message content
 */

/**
 * @typedef {Object} CanonicalRequest
 * @property {string} provider - The target provider name (e.g., 'openai', 'anthropic', 'gemini')
 * @property {string} model - The model identifier requested by the client
 * @property {string} actualModelId - The actual model ID to use (may differ from requested model)
 * @property {CanonicalMessage[]} messages - Array of conversation messages
 * @property {number} [temperature] - Sampling temperature (0-2)
 * @property {number} [maxTokens] - Maximum tokens to generate
 * @property {boolean} [stream] - Whether to stream the response
 * @property {boolean} [reasoningSupported] - Whether the model supports reasoning/thinking
 * @property {string} [reasoningEffort] - Reasoning effort level (e.g., 'low', 'medium', 'high')
 * @property {string} [fallbackModel] - Fallback model if primary fails
 * @property {boolean} [isFallback] - Whether this is a fallback request
 * @property {Object} [clientParams] - Original client parameters for reference
 * @property {Object} [resolvedModel] - Resolved model configuration from routing
 */

/**
 * Creates a canonical request object from the base parameters.
 *
 * @param {Object} params - Request parameters
 * @param {string} [params.provider] - Target provider
 * @param {string} [params.model] - Model identifier
 * @param {string} [params.actualModelId] - Actual model ID
 * @param {CanonicalMessage[]} [params.messages] - Conversation messages
 * @param {number} [params.temperature] - Sampling temperature
 * @param {number} [params.maxTokens] - Maximum tokens
 * @param {boolean} [params.stream] - Stream flag
 * @param {boolean} [params.reasoningSupported] - Reasoning support flag
 * @param {string} [params.reasoningEffort] - Reasoning effort level
 * @param {string} [params.fallbackModel] - Fallback model
 * @param {boolean} [params.isFallback] - Fallback flag
 * @param {Object} [params.clientParams] - Client parameters
 * @returns {CanonicalRequest} Canonical request object
 */
export function createCanonicalRequest(params = {}) {
  return {
    provider: params.provider || null,
    model: params.model || null,
    actualModelId: params.actualModelId || null,
    messages: params.messages || [],
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    stream: params.stream || false,
    reasoningSupported: params.reasoningSupported,
    reasoningEffort: params.reasoningEffort,
    fallbackModel: params.fallbackModel,
    isFallback: params.isFallback || false,
    clientParams: params.clientParams || null,
    resolvedModel: params.resolvedModel || null,
  };
}

/**
 * Validates that a request object meets the canonical structure requirements.
 *
 * @param {Object} req - Request object to validate
 * @returns {boolean} True if valid, false otherwise
 */
export function isValidCanonicalRequest(req) {
  if (!req || typeof req !== 'object') return false;
  if (!req.model || typeof req.model !== 'string') return false;
  if (!Array.isArray(req.messages)) return false;
  return true;
}
