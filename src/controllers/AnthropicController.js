/* eslint-disable max-len */
import { FORMATS, translateRequest, translateResponse } from '../translators/index.js';
import { StreamAccumulator } from '../utils/StreamAccumulator.js';
import { BaseController } from './BaseController.js';

/**
 * Maps OpenAI-style finish_reason values to Anthropic stop_reason equivalents.
 */
const STOP_REASON_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
};

/**
 * Protocol controller for the Anthropic-compatible ingress endpoints.
 */
export class AnthropicController extends BaseController {
  constructor(orchestrator) {
    super(orchestrator, 'anthropic');
  }

  /**
   * Processes an incoming Anthropic Messages API completion request.
   */
  async handleCompletion(req, res) {
    return this.executeRequest(req, res, {
      protocolName: 'Anthropic',
      translateReq: (body) => translateRequest(FORMATS.ANTHROPIC, FORMATS.OPENAI, body),
      translateRes: (response, body) => translateResponse(FORMATS.ANTHROPIC, FORMATS.OPENAI, response, body),
      handleStream: (resp, response, unifiedReq, reqLog, body) => this.handleStreamingResponse(resp, response, unifiedReq, reqLog, body),
    });
  }

  // eslint-disable-next-line class-methods-use-this
  async handleStreamingResponse(res, response, unifiedReq, reqLog, body) {
    this.logger.debug('Starting Anthropic SSE response stream');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    // State Machine Variables
    let messageStartSent = false;
    let activeBlockType = null;
    let currentBlockIndex = 0;
    const msgId = `msg_${Date.now()}`;
    let chunkCount = 0;

    const accumulator = new StreamAccumulator(msgId, unifiedReq.model);

    const transitionBlock = (newBlockType) => {
      if (activeBlockType === newBlockType) return;

      if (activeBlockType !== null) {
        const stopEvent = `event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index: currentBlockIndex,
        })}\n\n`;
        reqLog.appendStreamEvent('client', stopEvent);
        res.write(stopEvent);
        currentBlockIndex += 1;
      }

      if (newBlockType !== null) {
        const contentBlock = newBlockType === 'thinking'
          ? { type: 'thinking', thinking: '' }
          : { type: 'text', text: '' };

        const startEvent = `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: currentBlockIndex,
          content_block: contentBlock,
        })}\n\n`;
        reqLog.appendStreamEvent('client', startEvent);
        res.write(startEvent);
      }

      activeBlockType = newBlockType;
    };

    try {
      /* eslint-disable no-restricted-syntax */
      for await (const chunk of response) {
        chunkCount += 1;
        accumulator.processChunk(chunk);

        if (!messageStartSent) {
          const messageStartEvent = `event: message_start\ndata: ${JSON.stringify({
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
          })}\n\n`;
          reqLog.appendStreamEvent('client', messageStartEvent);
          res.write(messageStartEvent);
          messageStartSent = true;
        }

        const choice = chunk.choices?.[0] || {};
        const delta = choice.delta || {};

        if (delta.reasoning_content) {
          transitionBlock('thinking');
          const thinkingDelta = `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: {
              type: 'thinking_delta',
              thinking: delta.reasoning_content,
            },
          })}\n\n`;
          reqLog.appendStreamEvent('client', thinkingDelta);
          res.write(thinkingDelta);
        }

        if (delta.content) {
          transitionBlock('text');
          const textDelta = `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: {
              type: 'text_delta',
              text: delta.content,
            },
          })}\n\n`;
          reqLog.appendStreamEvent('client', textDelta);
          res.write(textDelta);
        }

        if (choice.finish_reason) {
          transitionBlock(null);
          const stopReason = STOP_REASON_MAP[choice.finish_reason] || choice.finish_reason || 'end_turn';
          const messageDelta = `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: {
              stop_reason: stopReason,
              stop_sequence: null,
            },
            usage: {
              output_tokens: 0,
            },
          })}\n\n`;
          reqLog.appendStreamEvent('client', messageDelta);
          res.write(messageDelta);
        }
      }
      /* eslint-enable no-restricted-syntax */

      transitionBlock(null);

      const messageStop = `event: message_stop\ndata: ${JSON.stringify({
        type: 'message_stop',
      })}\n\n`;
      reqLog.appendStreamEvent('client', messageStop);
      res.write(messageStop);
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
      reqLog.logClientResponse(0, {
        _streamed: true,
        _aborted: true,
        _eventCount: chunkCount,
        error: err.message,
      });
    } finally {
      await reqLog.finalize();
      res.end();
    }
    return res;
  }
}
