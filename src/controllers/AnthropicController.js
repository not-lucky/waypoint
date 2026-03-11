import { resolveModel, applyModelConfig, applyHeaderOverrides } from '../utils/modelResolver.js';

// Maps OpenAI-style finish_reason values to Anthropic stop_reason equivalents.
// Unmapped reasons (e.g. 'content_filter') are passed through as-is.
const STOP_REASON_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
};

/**
 * Converts an Anthropic system prompt (string or content-block array) to a
 * single string suitable for the unified system message.
 * Anthropic's API accepts system as either a plain string or an array of
 * content blocks like [{ type: 'text', text: '...' }].
 */
const formatSystemContent = (system) => {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((block) => block.text || '').join('\n');
  return String(system);
};

/**
 * Translates a NormalizedResponse (OpenAI-shaped) into the Anthropic Messages API format.
 * Maps reasoning_content to a 'thinking' content block and content to a 'text' block.
 * Converts usage from prompt_tokens/completion_tokens to input_tokens/output_tokens.
 */
const translateResponse = (normalized) => {
  const choice = normalized.choices?.[0] || {};
  const message = choice.message || {};

  // Build content blocks: thinking block first (if present), then text block
  const content = [];
  if (message.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content });
  }
  content.push({ type: 'text', text: message.content || '' });

  return {
    id: normalized.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: normalized.model,
    content,
    stop_reason: STOP_REASON_MAP[choice.finish_reason] || choice.finish_reason || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: normalized.usage?.prompt_tokens ?? 0,
      output_tokens: normalized.usage?.completion_tokens ?? 0,
    },
  };
};

/**
 * Protocol controller for the Anthropic-compatible ingress endpoints.
 * Translates inbound Anthropic Messages requests into UnifiedRequest format,
 * resolves model configuration and header overrides, dispatches to the orchestrator,
 * then translates the NormalizedResponse back into the Anthropic Messages schema.
 *
 * Mounted on: /anthropic/messages, /anthropic/v1/messages
 */
export class AnthropicController {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
  }

  async handleCompletion(req, res) {
    try {
      const body = req.body || {};
      const providersConfig = this.orchestrator.config?.providers || {};

      // Anthropic sends system prompt as a top-level 'system' field, not inside messages.
      // We prepend it as a standard system message for the unified format.
      const messages = [];
      if (body.system) {
        messages.push({ role: 'system', content: formatSystemContent(body.system) });
      }
      if (Array.isArray(body.messages)) {
        messages.push(...body.messages);
      }

      // Build the unified internal request from the Anthropic payload.
      // Anthropic uses max_tokens (current) or max_tokens_to_sample (legacy).
      const unifiedReq = {
        model: body.model,
        messages,
        temperature: body.temperature,
        maxTokens: body.max_tokens ?? body.max_tokens_to_sample ?? body.maxTokens,
        stream: body.stream || false,
        isFallback: false,
      };

      // Resolve model config then apply header-level overrides
      applyModelConfig(unifiedReq, resolveModel(body.model, providersConfig));
      const cleanRawReq = applyHeaderOverrides(unifiedReq, req);

      const response = await this.orchestrator.executeCompletion(unifiedReq, cleanRawReq);

      // Error responses use the same format regardless of client protocol
      if (response?.error) {
        return res.status(response.error.httpStatus || 500).json(response);
      }

      // If the response is a stream, translate to Anthropic SSE format and stream to client
      if (response && typeof response[Symbol.asyncIterator] === 'function') {
        // Set standard Server-Sent Events headers to disable proxy buffering
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');

        let messageStartSent = false;
        let activeBlockType = null; // Track currently active block type: 'text' or 'thinking'
        let currentBlockIndex = 0; // Incremented on each block type transition
        const msgId = `msg_${Date.now()}`;

        try {
          /* eslint-disable no-restricted-syntax */
          for await (const chunk of response) {
            // Send the message_start event on the first chunk to establish initial metadata
            if (!messageStartSent) {
              res.write(`event: message_start\ndata: ${JSON.stringify({
                type: 'message_start',
                message: {
                  id: chunk.id || msgId,
                  type: 'message',
                  role: 'assistant',
                  model: unifiedReq.model,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                  },
                },
              })}\n\n`);
              messageStartSent = true;
            }

            const choice = chunk.choices?.[0] || {};
            const delta = choice.delta || {};

            // Handle reasoning/thinking content first if present in the chunk
            if (delta.reasoning_content) {
              // Handle transitions from previous block types (e.g. text -> thinking)
              if (activeBlockType !== 'thinking') {
                if (activeBlockType !== null) {
                  res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                    type: 'content_block_stop',
                    index: currentBlockIndex,
                  })}\n\n`);
                  currentBlockIndex += 1;
                }
                // Send content_block_start for thinking
                res.write(`event: content_block_start\ndata: ${JSON.stringify({
                  type: 'content_block_start',
                  index: currentBlockIndex,
                  content_block: {
                    type: 'thinking',
                    thinking: '',
                  },
                })}\n\n`);
                activeBlockType = 'thinking';
              }

              // Send content_block_delta for thinking content
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: currentBlockIndex,
                delta: {
                  type: 'thinking_delta',
                  thinking: delta.reasoning_content,
                },
              })}\n\n`);
            }

            // Handle text content if present in the chunk
            if (delta.content) {
              // Handle transitions from previous block types (e.g. thinking -> text)
              if (activeBlockType !== 'text') {
                if (activeBlockType !== null) {
                  res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                    type: 'content_block_stop',
                    index: currentBlockIndex,
                  })}\n\n`);
                  currentBlockIndex += 1;
                }
                // Send content_block_start for text
                res.write(`event: content_block_start\ndata: ${JSON.stringify({
                  type: 'content_block_start',
                  index: currentBlockIndex,
                  content_block: {
                    type: 'text',
                    text: '',
                  },
                })}\n\n`);
                activeBlockType = 'text';
              }

              // Send content_block_delta for text content
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: currentBlockIndex,
                delta: {
                  type: 'text_delta',
                  text: delta.content,
                },
              })}\n\n`);
            }

            // Handle completion/finish reason
            if (choice.finish_reason) {
              if (activeBlockType !== null) {
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                  type: 'content_block_stop',
                  index: currentBlockIndex,
                })}\n\n`);
                activeBlockType = null;
              }

              // Map standard stop reasons (e.g., stop -> end_turn)
              const stopReason = STOP_REASON_MAP[choice.finish_reason] || choice.finish_reason || 'end_turn';
              res.write(`event: message_delta\ndata: ${JSON.stringify({
                type: 'message_delta',
                delta: {
                  stop_reason: stopReason,
                  stop_sequence: null,
                },
                usage: {
                  output_tokens: 0,
                },
              })}\n\n`);
            }
          }
          /* eslint-enable no-restricted-syntax */

          // Clean up any remaining active block stops at EOF
          if (activeBlockType !== null) {
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop',
              index: currentBlockIndex,
            })}\n\n`);
          }

          // Signal final message termination
          res.write(`event: message_stop\ndata: ${JSON.stringify({
            type: 'message_stop',
          })}\n\n`);
        } catch (err) {
          // Stream interrupted or aborted
        } finally {
          // Ensure connection is closed cleanly
          res.end();
        }
        return res;
      }

      // Translate from NormalizedResponse (OpenAI-shaped) to Anthropic Messages format
      return res.json(translateResponse(response));
    } catch (err) {
      // Catch-all for unexpected errors
      return res.status(500).json({
        error: {
          code: 'internal_server_error',
          message: err.message || String(err),
          httpStatus: 500,
        },
      });
    }
  }
}

export default AnthropicController;
