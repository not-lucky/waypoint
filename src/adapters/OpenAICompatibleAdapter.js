/* eslint-disable no-restricted-syntax, generator-star-spacing */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText } from 'ai';
import {
  BaseProvider, mapCompletionResult, mapStreamResult, normalizeProviderError,
} from './BaseProvider.js';

const getReasoningEffort = (req) => {
  const effort = req.thinkingLevel || req.reasoningEffort;
  if (!effort && req.thinkingEnabled) {
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
    });
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
    return normalizeProviderError(error, this.providerName);
  }
}

export default OpenAICompatibleAdapter;
