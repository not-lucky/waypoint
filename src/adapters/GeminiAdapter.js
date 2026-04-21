/* eslint-disable no-restricted-syntax, generator-star-spacing, class-methods-use-this */
import { createGoogleGenerativeAI as createGoogle } from '@ai-sdk/google';
import { generateText, streamText } from 'ai';
import {
  BaseProvider, mapCompletionResult, mapStreamResult, normalizeProviderError,
} from './BaseProvider.js';

const prepareOptions = (req, apiKey, extraOptions = {}) => {
  const googleProvider = createGoogle({ apiKey });
  const model = googleProvider(req.actualModelId);
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
      google: {
        thinkingConfig: {
          thinkingBudget: req.thinkingBudget !== undefined ? req.thinkingBudget : 2048,
        },
      },
    };
  }

  return options;
};

export class GeminiAdapter extends BaseProvider {
  /**
   * Generates a non-streaming text completion.
   * @param {UnifiedRequest} req - Normalized request payload.
   * @param {string} apiKey - Upstream API key.
   * @param {AbortSignal} [signal] - Optional signal to abort the completion request.
   * @returns {Promise<NormalizedResponse>}
   */
  async generateCompletion(req, apiKey, signal) {
    // Forward abort signal to generateText options to cancel upstream request.
    const options = prepareOptions(req, apiKey, { abortSignal: signal });
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
    const options = prepareOptions(req, apiKey, { abortSignal: signal });
    const result = streamText(options);
    yield* mapStreamResult(result);
  }

  normalizeError(error) {
    return normalizeProviderError(error, 'gemini');
  }
}

export default GeminiAdapter;
