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

  async generateCompletion(req, apiKey) {
    const options = prepareOptions(this, req, apiKey);
    const result = await generateText(options);
    return mapCompletionResult(req, result);
  }

  async *generateStream(req, apiKey, signal) {
    const options = prepareOptions(this, req, apiKey, { abortSignal: signal });
    const result = streamText(options);
    yield* mapStreamResult(result);
  }

  normalizeError(error) {
    return normalizeProviderError(error, 'anthropic');
  }
}

export default AnthropicAdapter;
