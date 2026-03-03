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

  if (req.thinkingEnabled) {
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
  async generateCompletion(req, apiKey) {
    const options = prepareOptions(req, apiKey);
    const result = await generateText(options);
    return mapCompletionResult(req, result);
  }

  async *generateStream(req, apiKey, signal) {
    const options = prepareOptions(req, apiKey, { abortSignal: signal });
    const result = streamText(options);
    yield* mapStreamResult(result);
  }

  normalizeError(error) {
    return normalizeProviderError(error, 'gemini');
  }
}

export default GeminiAdapter;
