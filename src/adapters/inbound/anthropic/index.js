import { formatAnthropicSseError } from '../../../domain/errors/envelope.js';
import { startSSEStream } from '../../../utils/streaming/sseUtils.js';
import { FORMATS, translateRequest, translateResponse } from '../../transforms/index.js';
import { StreamAccumulator } from '../../../utils/streaming/streamAccumulator.js';
import { BaseController } from '../base.js';

const STOP_REASON_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
};

function writeSseEvent(res, reqLog, eventType, data) {
  const event = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  reqLog.appendStreamEvent('client', event);
  res.write(event);
}

/**
 * Protocol controller for the Anthropic Messages ingress.
 * Upstream may be OpenAI/Anthropic/Gemini; ingress is Anthropic-shape.
 */
export class AnthropicController extends BaseController {
  constructor(orchestrator) {
    super(orchestrator, 'anthropic');
  }

  async handleCompletion(req, res) {
    return this.executeRequest(req, res, {
      protocolName: 'Anthropic',
      ingressFormat: FORMATS.ANTHROPIC,
      translateReq: (body) => translateRequest(FORMATS.ANTHROPIC, FORMATS.OPENAI, body),
      translateRes: (response, body) => translateResponse(FORMATS.ANTHROPIC, FORMATS.OPENAI, response, body),
      handleStream: (resp, response, unifiedReq, reqLog, body) => this.handleStreamingResponse(resp, response, unifiedReq, reqLog, body),
    });
  }

  async handleStreamingResponse(res, response, unifiedReq, reqLog, body) {
    this.logger.debug('Starting Anthropic SSE response stream');

    startSSEStream(res);

    let messageStartSent = false;
    let activeBlockType = null;
    let activeToolMeta = null;
    let currentBlockIndex = 0;
    const msgId = `msg_${Date.now()}`;
    let chunkCount = 0;

    const accumulator = new StreamAccumulator(msgId, unifiedReq.model);

    const transitionBlock = (newBlockType, toolMeta = null) => {
      if (activeBlockType === newBlockType
        && newBlockType !== 'tool_use'
        && activeBlockType !== 'tool_use') {
        return;
      }

      if (activeBlockType !== null) {
        writeSseEvent(res, reqLog, 'content_block_stop', {
          type: 'content_block_stop',
          index: currentBlockIndex,
        });
        currentBlockIndex += 1;
      }

      if (newBlockType !== null) {
        let contentBlock;
        if (newBlockType === 'thinking') {
          contentBlock = { type: 'thinking', thinking: '' };
        } else if (newBlockType === 'tool_use') {
          contentBlock = {
            type: 'tool_use',
            id: toolMeta?.id || '',
            name: toolMeta?.name || '',
            input: {},
          };
        } else {
          contentBlock = { type: 'text', text: '' };
        }

        writeSseEvent(res, reqLog, 'content_block_start', {
          type: 'content_block_start',
          index: currentBlockIndex,
          content_block: contentBlock,
        });
      }

      activeBlockType = newBlockType;
      activeToolMeta = toolMeta;
    };

    try {
      for await (const chunk of response) {
        chunkCount += 1;
        accumulator.processChunk(chunk);

        if (!messageStartSent) {
          writeSseEvent(res, reqLog, 'message_start', {
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
          });
          messageStartSent = true;
        }

        const choice = chunk.choices?.[0] || {};
        const delta = choice.delta || {};

        if (delta.reasoning_content) {
          transitionBlock('thinking');
          writeSseEvent(res, reqLog, 'content_block_delta', {
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: {
              type: 'thinking_delta',
              thinking: delta.reasoning_content,
            },
          });
        }

        if (delta.content) {
          transitionBlock('text');
          writeSseEvent(res, reqLog, 'content_block_delta', {
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: {
              type: 'text_delta',
              text: delta.content,
            },
          });
        }

        if (delta.tool_calls?.length) {
          for (const toolCall of delta.tool_calls) {
            if (toolCall.id || toolCall.function?.name) {
              transitionBlock('tool_use', {
                id: toolCall.id || activeToolMeta?.id || '',
                name: toolCall.function?.name || activeToolMeta?.name || '',
              });
            }
            if (toolCall.function?.arguments) {
              writeSseEvent(res, reqLog, 'content_block_delta', {
                type: 'content_block_delta',
                index: currentBlockIndex,
                delta: {
                  type: 'input_json_delta',
                  partial_json: toolCall.function.arguments,
                },
              });
            }
          }
        }

        if (choice.finish_reason) {
          transitionBlock(null);
          const stopReason = STOP_REASON_MAP[choice.finish_reason] || choice.finish_reason || 'end_turn';
          writeSseEvent(res, reqLog, 'message_delta', {
            type: 'message_delta',
            delta: {
              stop_reason: stopReason,
              stop_sequence: null,
            },
            usage: {
              output_tokens: 0,
            },
          });
        }
      }

      transitionBlock(null);

      writeSseEvent(res, reqLog, 'message_stop', {
        type: 'message_stop',
      });
      this.logger.debug('Anthropic SSE response stream completed', { chunkCount });

      const normalized = accumulator.buildNormalizedResponse();
      const translatedResponse = translateResponse(FORMATS.ANTHROPIC, FORMATS.OPENAI, normalized, body);

      reqLog.logClientStreamSummary({
        _format: 'anthropic-sse',
        _eventCount: chunkCount,
        summary: {
          ...translatedResponse,
          _streamed: true,
        },
      });
    } catch (err) {
      this.logger.debug('Anthropic SSE response stream aborted or failed', { chunkCount, error: err.message });
      // Upstream format is best-effort: the orchestrator's normalized response doesn't
      // carry the upstream format; we default to OPENAI since the unified shape is
      // OpenAI-shaped after the orchestrator returns.
      this.emitStreamError(
        res,
        reqLog,
        err,
        formatAnthropicSseError,
        FORMATS.OPENAI,
        FORMATS.ANTHROPIC,
        chunkCount,
      );
    } finally {
      await reqLog.finalize();
      res.end();
    }
    return res;
  }
}
