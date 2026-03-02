/* eslint-disable no-restricted-syntax, generator-star-spacing */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText } from 'ai';
import { BaseProvider } from './BaseProvider.js';

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
    const model = this.provider.chatModel(req.actualModelId);
    const options = {
      model,
      messages: req.messages,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
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
        [this.providerName]: {
          reasoningEffort: effort,
        },
      };
    }

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
    const model = this.provider.chatModel(req.actualModelId);
    const options = {
      model,
      messages: req.messages,
      abortSignal: signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
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
        [this.providerName]: {
          reasoningEffort: effort,
        },
      };
    }

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
    const status = error?.response?.status;
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
      provider: this.providerName,
      providerName: this.providerName,
    };
  }
}

export default OpenAICompatibleAdapter;
