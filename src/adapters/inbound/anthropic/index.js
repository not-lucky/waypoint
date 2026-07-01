import { formatAnthropicSseError } from '../../../domain/errors/envelope.js';
import { FORMATS, translateRequest, translateResponse } from '../../transforms/index.js';
import { StreamAccumulator } from '../../../utils/streaming/streamAccumulator.js';
import { startSSEStream } from '../../../utils/streaming/sseSetup.js';
import { BaseController } from '../base.js';

/**
 * Maps OpenAI `finish_reason` values to Anthropic `stop_reason` values.
 *
 * OpenAI uses `tool_calls` to indicate a tool invocation; Anthropic uses
 * `tool_use`. Both use `length` and `stop` for token-limit and natural
 * completion respectively.
 *
 * @const {Object<string, string>}
 */
const STOP_REASON_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
};

/**
 * The set of top-level request keys the Anthropic ingress understands.
 *
 * Any key outside this set is treated as a provider-specific extension
 * (`extraBody`-style) and is passed through to the routing transformer
 * for allowedExtraBody filtering, then forwarded to the upstream.
 *
 * @type {Set<string>}
 */
const ANTHROPIC_REQUEST_KEYS = new Set([
  'model',
  'messages',
  'max_tokens',
  'system',
  'tools',
  'tool_choice',
  'temperature',
  'stream',
  'extraBody',
]);

/**
 * Writes a single Anthropic SSE event frame to the response.
 *
 * Anthropic's protocol uses two-line framing per event (`event: ...` then
 * `data: ...`), separated by a blank line. Both lines are recorded in the
 * per-request debug log.
 *
 * @param {import('express').Response} res - Express response.
 * @param {Object} reqLog - Per-request debug logger.
 * @param {string} eventType - SSE event type (e.g. `'message_start'`).
 * @param {Object} data - JSON-serializable event payload.
 * @returns {void}
 */
const writeSseEvent = (res, reqLog, eventType, data) => {
  const event = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  reqLog.appendStreamEvent('client', event);
  res.write(event);
};

/**
 * Protocol controller for the Anthropic Messages ingress.
 *
 * Upstream may be OpenAI/Anthropic/Gemini; ingress is Anthropic-shape.
 * Request bodies are translated to the OpenAI hub format (which is the
 * gateway's internal canonical representation), and responses are
 * translated back to the Anthropic shape.
 *
 * @extends BaseController
 */
export class AnthropicController extends BaseController {
  /**
   * @param {import('../../../application/orchestrator.js').UnifiedOrchestrator} orchestrator -
   *   The shared orchestrator.
   */
  constructor(orchestrator) {
    super(orchestrator, 'anthropic');
  }

  /**
   * Entry point for the `/messages` route. Delegates to `executeRequest`
   * with Anthropic ingress format and the protocol-specific translators.
   *
   * @async
   * @param {import('express').Request} req - Express request.
   * @param {import('express').Response} res - Express response.
   * @returns {Promise<import('express').Response>}
   */
  async handleCompletion(req, res) {
    return this.executeRequest(req, res, {
      protocolName: 'Anthropic',
      ingressFormat: FORMATS.ANTHROPIC,
      translateReq: (body) => {
        const translated = {
          ...translateRequest(FORMATS.ANTHROPIC, FORMATS.OPENAI, body),
          // Preserve client-supplied provider-specific request parameters (extraBody)
          // during translation from Anthropic layout into standard OpenAI format.
          extraBody: body.extraBody,
        };

        // Carry forward unknown top-level request keys so the routing transformer
        // can apply the same allowedExtraBody filtering used for OpenAI ingress.
        for (const [key, value] of Object.entries(body)) {
          if (!ANTHROPIC_REQUEST_KEYS.has(key)) {
            translated[key] = value;
          }
        }

        return translated;
      },
      translateRes: (response, body) => translateResponse(FORMATS.ANTHROPIC, FORMATS.OPENAI, response, body),
      handleStream: (resp, response, unifiedReq, reqLog, body) => this.handleStreamingResponse(resp, response, unifiedReq, reqLog, body),
    });
  }

  /**
   * Streams the upstream response to the client as Anthropic SSE events.
   *
   * Implements a small state machine that tracks the active content block
   * (`text`, `thinking`, or `tool_use`) and emits the appropriate
   * `content_block_start` / `content_block_delta` / `content_block_stop`
   * event sequence. Also emits the `message_start`, `ping`,
   * `message_delta`, and `message_stop` envelope events required by
   * Anthropic's protocol.
   *
   * Side effects: writes SSE events to the response, maintains a
   * per-request accumulator for the debug log, and emits an SSE error
   * frame on stream failure.
   *
   * @async
   * @param {import('express').Response} res - Express response.
   * @param {AsyncIterable<Object>} response - Async iterable of OpenAI-shaped chunks.
   * @param {Object} unifiedReq - Normalized request (for model id in message_start).
   * @param {Object} reqLog - Per-request debug logger.
   * @param {Object} body - The original ingress request body.
   * @returns {Promise<import('express').Response>}
   */
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
      if (activeBlockType === newBlockType) {
        if (newBlockType !== 'tool_use') return;
        const sameTool =
          (activeToolMeta?.id || '') === (toolMeta?.id || '')
          && (activeToolMeta?.name || '') === (toolMeta?.name || '');
        if (sameTool) return;
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
