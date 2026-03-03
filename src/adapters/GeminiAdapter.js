/* eslint-disable no-restricted-syntax, generator-star-spacing, class-methods-use-this */
import { createGoogleGenerativeAI as createGoogle } from '@ai-sdk/google';
import { generateText, streamText } from 'ai';
import { BaseProvider } from './BaseProvider.js';

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
    const options = prepareOptions(req, apiKey, { abortSignal: signal });
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
      provider: 'gemini',
      providerName: 'gemini',
    };
  }
}

export default GeminiAdapter;
