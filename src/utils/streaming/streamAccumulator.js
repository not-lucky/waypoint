import { extractReasoningText } from '../../adapters/outbound/shared/openaiResponse.js';
import { mergeToolCallDeltas } from '../../adapters/outbound/shared/openaiToolCalls.js';

/**
 * Accumulates streaming tokens and usage metadata from individual SSE chunks to reconstruct
 * a canonical, normalized non-streaming response structure.
 *
 * This utility class is crucial for logging, retry-fallback logic, and auditing where a complete,
 * aggregated response structure (representing the full conversational turn) must be projected
 * from the stream session.
 */
export class StreamAccumulator {
  /**
   * Initializes a new StreamAccumulator instance.
   *
   * @param {string|null} [defaultId=null] - Default fallback ID to use if the chunks do not provide one.
   * @param {string|null} [defaultModel=null] - Default model identifier to use if the chunks do not specify the model.
   */
  constructor(defaultId = null, defaultModel = null) {
    this.responseId = defaultId;
    this.responseModel = defaultModel;
    this.choicesAccumulator = [];
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.totalTokens = 0;
  }

  /**
   * Processes an incoming stream chunk, extracting and accumulating token increments,
   * tool calls, reasoning content, and usage metrics.
   *
   * Mutates the accumulator's internal state. It handles:
   * 1. Lazily creating message structures for choice indices.
   * 2. Appending standard text content and reasoning content.
   * 3. Merging progressive tool call deltas into full tool call arrays.
   * 4. Tracking usage token totals.
   *
   * @param {Object} chunk - The parsed OpenAI-compatible stream chunk object.
   * @param {string} [chunk.id] - The stream-wide completion ID.
   * @param {string} [chunk.model] - The model serving the request.
   * @param {Array<Object>} [chunk.choices] - Choices array carrying content or tool call deltas.
   * @param {Object} [chunk.usage] - Real-time usage statistics (often provided in the last chunk).
   */
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

  /**
   * Synthesizes the accumulated state into a normalized, single-turn non-streaming response object.
   *
   * Formats the final message fields (e.g. cleans up empty arrays or null fields where appropriate)
   * and computes or maps overall token usage metrics.
   *
   * @returns {Object} A normalized OpenAI-compatible completion response body.
   */
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

