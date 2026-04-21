/* eslint-disable no-restricted-syntax, generator-star-spacing */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText } from 'ai';
import {
  BaseProvider, mapCompletionResult, mapStreamResult, normalizeProviderError,
} from './BaseProvider.js';

const getReasoningEffort = (req) => {
  const effort = req.thinkingLevel || req.reasoningEffort;
  const thinkingEnabled = req.thinkingEnabled || req.thinking_supported || false;
  if (!effort && thinkingEnabled) {
    if (req.thinkingBudget !== undefined) {
      if (req.thinkingBudget <= 1024) {
        return 'low';
      }
      if (req.thinkingBudget <= 2048) {
        return 'medium';
      }
      return 'high';
    }
    return 'medium';
  }
  return effort;
};

const prepareOptions = (adapter, req, apiKey, extraOptions = {}) => {
  const model = adapter.provider.chatModel(req.actualModelId);
  const options = {
    model,
    messages: req.messages,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    ...extraOptions,
  };

  if (req.temperature !== undefined) {
    options.temperature = req.temperature;
  }
  if (req.maxTokens !== undefined) {
    options.maxTokens = req.maxTokens;
  }

  const effort = getReasoningEffort(req);
  if (effort) {
    options.providerOptions = {
      [adapter.providerName]: {
        reasoningEffort: effort,
      },
    };
  }

  return options;
};

export class OpenAICompatibleAdapter extends BaseProvider {
  constructor(baseUrl, providerName) {
    super();
    this.baseUrl = baseUrl;
    this.providerName = providerName;
    this.provider = createOpenAICompatible({
      baseURL: baseUrl,
      name: providerName,
      // Custom proxy providers (like omniroute) may default to stream: true if omitted.
      // We explicitly set stream: false when it is falsy or missing to prevent the
      // API from returning an EventStream that would fail to parse as JSON.
      transformRequestBody: (body) => ({
        ...body,
        stream: body.stream ?? false,
      }),
    });
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
    return normalizeProviderError(error, this.providerName);
  }
}

export default OpenAICompatibleAdapter;
