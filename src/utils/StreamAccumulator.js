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
            },
            finish_reason: null,
          };
        }
        const choice = this.choicesAccumulator[idx];
        if (c.delta) {
          if (c.delta.content) {
            choice.message.content += c.delta.content;
          }
          if (c.delta.reasoning_content) {
            if (choice.message.reasoning_content === null) {
              choice.message.reasoning_content = '';
            }
            choice.message.reasoning_content += c.delta.reasoning_content;
          }
        }
        if (c.finish_reason || c.finishReason) {
          choice.finish_reason = c.finish_reason || c.finishReason;
        }
      }
    }

    if (chunk.usage) {
      this.promptTokens = chunk.usage.prompt_tokens ?? chunk.usage.promptTokens ?? this.promptTokens;
      this.completionTokens = chunk.usage.completion_tokens ?? chunk.usage.completionTokens ?? this.completionTokens;
      this.totalTokens = chunk.usage.total_tokens ?? chunk.usage.totalTokens ?? this.totalTokens;
    }
  }

  buildNormalizedResponse() {
    return {
      id: this.responseId,
      model: this.responseModel,
      choices: this.choicesAccumulator.filter(Boolean).map((c) => {
        const msg = {
          role: c.message.role,
          content: c.message.content,
        };
        if (c.message.reasoning_content !== null) {
          msg.reasoning_content = c.message.reasoning_content;
        }
        return {
          message: msg,
          finish_reason: c.finish_reason || 'stop',
        };
      }),
      usage: {
        prompt_tokens: this.promptTokens,
        completion_tokens: this.completionTokens,
        total_tokens: this.totalTokens || (this.promptTokens + this.completionTokens),
      },
    };
  }
}
