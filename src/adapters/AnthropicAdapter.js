/* eslint-disable no-restricted-syntax, generator-star-spacing, class-methods-use-this */
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, streamText } from 'ai';
import {
  BaseProvider, mapCompletionResult, mapStreamResult, normalizeProviderError,
} from './BaseProvider.js';

const prepareOptions = (adapter, req, apiKey, extraOptions = {}) => {
  const providerOpts = { apiKey };
  if (adapter.baseUrl) {
    providerOpts.baseURL = adapter.baseUrl;
  }
  const anthropicInstance = createAnthropic(providerOpts);
  const model = anthropicInstance(req.actualModelId);
  const options = {
    model,
    messages: req.messages,
    ...extraOptions,
  };

  if (req.temperature !== undefined) {
    options.temperature = req.temperature;
  }
  if (req.maxTokens !== undefined) {
    options.maxTokens = req.maxTokens;
  }

  const thinkingEnabled = req.thinkingEnabled || req.thinking_supported || false;
  if (thinkingEnabled) {
    options.providerOptions = {
      anthropic: {
        thinking: {
          type: 'enabled',
          budgetTokens: req.thinkingBudget !== undefined ? req.thinkingBudget : 2048,
        },
      },
    };
  }

  return options;
};

export class AnthropicAdapter extends BaseProvider {
  constructor(baseUrl = null) {
    super();
    this.baseUrl = baseUrl;
  }

  /**
   * Generates a non-streaming text completion.
   * @param {UnifiedRequest} req - Normalized request payload.
   * @param {string} apiKey - Upstream API key.
   * @param {AbortSignal} [signal] - Optional signal to abort the completion request.
   * @returns {Promise<NormalizedResponse>}
   */
  async generateCompletion(req, apiKey, signal) {
    // Forward abort signal to generateText options to cancel upstream request.
    const options = prepareOptions(this, req, apiKey, { abortSignal: signal });
    const result = await generateText(options);
    return mapCompletionResult(req, result);
  }

  /**
   * Generates a streaming text completion.
   * @param {UnifiedRequest} req - Normalized request payload.
   * @param {string} apiKey - Upstream API key.
   * @param {AbortSignal} [signal] - Optional signal to abort the streaming connection.
   * @returns {AsyncGenerator<StreamChunk>}
   */
  async *generateStream(req, apiKey, signal) {
    // Forward abort signal to streamText options to cancel upstream connection.
    const options = prepareOptions(this, req, apiKey, { abortSignal: signal });
    const result = streamText(options);
    yield* mapStreamResult(result);
  }

  normalizeError(error) {
    return normalizeProviderError(error, 'anthropic');
  }
}

export default AnthropicAdapter;
