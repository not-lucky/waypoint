/* eslint-disable no-restricted-syntax, generator-star-spacing, class-methods-use-this */
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, streamText } from 'ai';
import { BaseProvider } from './BaseProvider.js';

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
    const created = Math.floor(Date.now() / 1000);

    return {
      id: `waypoint-${Date.now()}`,
      object: 'chat.completion',
      created,
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
    };
  }

  async *generateStream(req, apiKey, signal) {
    const options = prepareOptions(this, req, apiKey, { abortSignal: signal });
    const result = streamText(options);
    const chunkId = `waypoint-chunk-${Date.now()}`;

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        yield {
          id: chunkId,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                content: part.text || null,
                reasoning_content: null,
              },
              finish_reason: null,
            },
          ],
        };
      } else if (part.type === 'reasoning-delta') {
        yield {
          id: chunkId,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                content: null,
                reasoning_content: part.text || null,
              },
              finish_reason: null,
            },
          ],
        };
      } else if (part.type === 'finish') {
        yield {
          id: chunkId,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                content: null,
                reasoning_content: null,
              },
              finish_reason: part.finishReason || 'stop',
            },
          ],
        };
      }
    }
  }

  normalizeError(error) {
    const status = error?.statusCode || error?.response?.status;
    let code = 'upstream_error';
    let httpStatus = 502;

    if (status === 429) {
      code = 'upstream_rate_limited';
      httpStatus = 503;
    } else if (status === 402 || status === 403) {
      code = 'quota_exhausted';
      httpStatus = 503;
    }

    return {
      code,
      message: error?.message || String(error),
      httpStatus,
      provider: 'anthropic',
      providerName: 'anthropic',
    };
  }
}

export default AnthropicAdapter;
