/* eslint-disable max-len */
import { extractReasoningText } from '../adapters/shared/openaiResponse.js';
import { mergeToolCallDeltas } from '../adapters/shared/openaiToolCalls.js';

export class StreamAccumulator {
  constructor(defaultId = null, defaultModel = null) {
    this.responseId = defaultId;
    this.responseModel = defaultModel;
    this.choicesAccumulator = [];
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.totalTokens = 0;
  }

  processChunk(chunk) {
    if (chunk.id) {
      this.responseId = chunk.id;
    }
    if (chunk.model) {
      this.responseModel = chunk.model;
    }

    if (chunk.choices) {
      for (const c of chunk.choices) {
        const idx = c.index ?? 0;
        if (!this.choicesAccumulator[idx]) {
          this.choicesAccumulator[idx] = {
            index: idx,
            message: {
              role: 'assistant',
              content: '',
              reasoning_content: null,
              tool_calls: null,
            },
            finish_reason: null,
          };
        }
        const choice = this.choicesAccumulator[idx];
        if (c.delta) {
          if (c.delta.content) {
            choice.message.content += c.delta.content;
          }
          const reasoningDelta = extractReasoningText(c.delta);
          if (reasoningDelta) {
            if (choice.message.reasoning_content === null) {
              choice.message.reasoning_content = '';
            }
            choice.message.reasoning_content += reasoningDelta;
          }
          if (c.delta?.tool_calls) {
            choice.message.tool_calls = mergeToolCallDeltas(
              choice.message.tool_calls,
              c.delta.tool_calls,
            );
          }
        }
        if (c.message?.tool_calls) {
          choice.message.tool_calls = c.message.tool_calls;
        }
        if (c.finish_reason) {
          choice.finish_reason = c.finish_reason;
        }
      }
    }

    if (chunk.usage) {
      this.promptTokens = chunk.usage.prompt_tokens ?? this.promptTokens;
      this.completionTokens = chunk.usage.completion_tokens ?? this.completionTokens;
      this.totalTokens = chunk.usage.total_tokens ?? this.totalTokens;
    }
  }

  buildNormalizedResponse() {
    const choices = [];
    for (const choice of this.choicesAccumulator) {
      if (!choice) continue;

      const msg = {
        role: choice.message.role,
        content: choice.message.content,
      };
      if (choice.message.reasoning_content !== null) {
        msg.reasoning_content = choice.message.reasoning_content;
      }
      if (choice.message.tool_calls?.length) {
        msg.tool_calls = choice.message.tool_calls;
      }

      choices.push({
        message: msg,
        finish_reason: choice.finish_reason || 'stop',
      });
    }

    return {
      id: this.responseId,
      model: this.responseModel,
      choices,
      usage: {
        prompt_tokens: this.promptTokens,
        completion_tokens: this.completionTokens,
        total_tokens: this.totalTokens || (this.promptTokens + this.completionTokens),
      },
    };
  }
}
