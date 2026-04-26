/* eslint-disable max-classes-per-file, class-methods-use-this, no-unused-vars */
/* eslint-disable no-restricted-syntax, generator-star-spacing, camelcase */

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

/**
 * Abstract base class for all provider adapters.
 * Ensures consistent interfaces so the UnifiedOrchestrator can easily hot-swap adapters.
 */
export class BaseProvider {
  /**
   * Combines an optional client abort signal with an optional configured timeout signal.
   * This is critical to ensure upstream requests don't hang indefinitely if the provider
   * stalls or if the original client drops the connection prematurely.
   * 
   * @param {AbortSignal} [signal] - Client abort signal.
   * @param {number} [timeoutMs] - Configured timeout in milliseconds.
   * @returns {Object} Mapped signal and cleanup function.
   */
  getTimeoutSignal(signal, timeoutMs) {
    if (!timeoutMs) {
      return { signal, cleanup: () => {} };
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);

    if (!signal) {
      return { signal: timeoutSignal, cleanup: () => {} };
    }

    // Try using the native AbortSignal.any if running on newer Node versions
    if (typeof AbortSignal.any === 'function') {
      try {
        const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
        return { signal: combinedSignal, cleanup: () => {} };
      } catch (err) {
        // Fall back to manual combination
      }
    }

    // Polyfill for AbortSignal.any
    const controller = new AbortController();
    const onAbort = () => controller.abort();

    signal.addEventListener('abort', onAbort);
    timeoutSignal.addEventListener('abort', onAbort);

    if (signal.aborted || timeoutSignal.aborted) {
      controller.abort();
    }

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      timeoutSignal.removeEventListener('abort', onAbort);
    };

    return { signal: controller.signal, cleanup };
  }

  /**
   * Generates a non-streaming completion.
   * @param {UnifiedRequest} req - The normalized internal request.
   * @param {string} apiKey - The upstream provider API key.
   * @param {AbortSignal} signal - Signal to abort the request.
   * @returns {Promise<NormalizedResponse>}
   * @throws {NotImplementedError}
   */
  async generateCompletion(req, apiKey, signal) {
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

/**
 * Default generic mapping for raw text completions.
 */
export const mapCompletionResult = (req, result) => ({
  id: `waypoint-${Date.now()}`,
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: req.model,
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: result.text || '',
        reasoning_content: result.reasoning || null,
      },
      finish_reason: result.finishReason || 'stop',
    },
  ],
  usage: {
    prompt_tokens: result.usage?.promptTokens ?? 0,
    completion_tokens: result.usage?.completionTokens ?? 0,
    total_tokens: result.usage?.totalTokens ?? 0,
  },
});

const chunkMappers = {
  'text-delta': (part) => ({ content: part.text || null, reasoning_content: null, finish_reason: null }),
  'reasoning-delta': (part) => ({ content: null, reasoning_content: part.text || null, finish_reason: null }),
  finish: (part) => ({ content: null, reasoning_content: null, finish_reason: part.finishReason || 'stop' }),
};

export const mapStreamResult = async function* mapStreamResult(result) {
  const chunkId = `waypoint-chunk-${Date.now()}`;
  for await (const part of result.fullStream) {
    const mapper = chunkMappers[part.type];
    if (mapper) {
      const { content, reasoning_content, finish_reason } = mapper(part);
      yield {
        id: chunkId,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content, reasoning_content }, finish_reason }],
      };
    }
  }
};

/**
 * Map provider HTTP errors to internal registry behavior codes.
 * This ensures the KeyRegistry knows whether to immediately ban a key (403) or exponential backoff (429).
 */
const ERROR_MAP = {
  429: { code: 'upstream_rate_limited', httpStatus: 503 },
  402: { code: 'quota_exhausted', httpStatus: 503 },
  403: { code: 'quota_exhausted', httpStatus: 503 },
};

export const normalizeProviderError = (error, providerName) => {
  const status = error?.statusCode ?? error?.response?.status;
  const { code, httpStatus } = ERROR_MAP[status] ?? { code: 'upstream_error', httpStatus: 502 };

  return {
    code,
    message: error?.message || String(error),
    httpStatus,
    provider: providerName,
    providerName,
  };
};

export default BaseProvider;