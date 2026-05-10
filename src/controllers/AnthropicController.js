/* eslint-disable max-len */
import { resolveModel, applyModelConfig, applyHeaderOverrides } from '../utils/modelResolver.js';
import { getAppLogger } from '../utils/logger.js';
import { createRequestLog } from '../utils/requestLogger.js';
import { FORMATS, translateRequest, translateResponse } from '../translators/index.js';
import { StreamAccumulator } from '../utils/StreamAccumulator.js';

const logger = getAppLogger('anthropic');

/**
 * Maps OpenAI-style finish_reason values to Anthropic stop_reason equivalents.
 *
 * Why: The internal pipeline operates strictly on OpenAI normalization to decouple
 * upstream providers from downstream clients. However, Anthropic SDKs throw validation
 * exceptions if they encounter unknown stop reasons. This map ensures we fulfill
 * Anthropic's strict type contracts (e.g., 'stop' -> 'end_turn') while safely passing
 * through unmapped edge-cases like 'content_filter' to avoid masking underlying AI safety triggers.
 */
const STOP_REASON_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
};

/**
 * Protocol controller for the Anthropic-compatible ingress endpoints.
 *
 * What: Translates inbound Anthropic Messages requests, resolves configurations,
 * coordinates execution via the orchestrator, and formats responses.
 *
 * Why: To allow Waypoint to transparently masquerade as an Anthropic API server.
 * By isolating protocol-specific ingestion here, the core orchestrator remains
 * provider-agnostic. This architectural boundary prevents Anthropic-specific
 * concepts (like SSE message_start sequences or distinct thinking blocks) from
 * bleeding into the core routing and retry logic.
 *
 * Mounted on: /anthropic/messages, /anthropic/v1/messages
 */
export class AnthropicController {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
  }

  /**
   * Processes an incoming Anthropic Messages API completion request.
   *
   * What: Normalizes the request, invokes the orchestrator, and manages the lifecycle
   * of both synchronous and streamed responses back to the client.
   *
   * Why: Anthropic's stream protocol is significantly more complex than OpenAI's,
   * relying on a stateful sequence of block starts, deltas, and stops. This method
   * acts as a state machine during streaming to bridge the gap between OpenAI's stateless
   * chunking and Anthropic's stateful SSE events.
   */
  async handleCompletion(req, res) {
    // What: Initialize audit logging.
    // Why: Given the multi-stage translation (Anthropic -> Unified -> Orchestrator -> Unified -> Anthropic),
    // tracing the exact point of failure is critical. This logger ensures we capture the
    // raw payload before it is mutated by the translation layers.
    const reqLog = createRequestLog(req, this.orchestrator.config);

    try {
      const body = req.body || {};
      const providersConfig = this.orchestrator.config?.providers || {};

      // What: Translate Anthropic request to UnifiedRequest (OpenAI format).
      // Why: Maintaining a single internal lingua franca reduces the M*N translation matrix
      // problem to M+N. We translate to OpenAI format here because the orchestrator and
      // most downstream providers natively speak or easily map to it.
      const unifiedReq = translateRequest(FORMATS.ANTHROPIC, FORMATS.OPENAI, body);

      // What: Resolve actual provider/model routing and apply overrides.
      // Why: The client may request 'claude-3-sonnet', but the config might map this to
      // a specific AWS Bedrock ARN or an OpenAI-compatible fallback. Header overrides
      // allow dynamic, per-request routing injections without changing the payload schema.
      applyModelConfig(unifiedReq, resolveModel(body.model, providersConfig));
      const cleanRawReq = applyHeaderOverrides(unifiedReq, req);

      logger.debug('Anthropic completion request received', {
        model: body.model,
        systemPromptPresent: !!body.system,
        messagesCount: body.messages?.length || 0,
        stream: body.stream || false,
        resolvedProvider: unifiedReq.provider,
        resolvedModel: unifiedReq.actualModelId,
      });

      // What: Hand off to the orchestrator for execution.
      // Why: The orchestrator abstracts away retries, failovers, and provider-specific quirks,
      // returning a normalized async iterator (for streams) or a resolved object.
      const response = await this.orchestrator.executeCompletion(unifiedReq, cleanRawReq, reqLog);

      // What: Handle upstream errors gracefully.
      // Why: Anthropic clients are resilient to standard HTTP error codes, so we map internal
      // orchestrator errors directly to HTTP statuses, ensuring the client SDK receives
      // a recognizable error shape rather than a hanging connection.
      if (response?.error) {
        logger.debug('Anthropic completion failed', { error: response.error });
        const statusCode = response.error.httpStatus || 500;
        reqLog.logClientResponse(statusCode, response);
        await reqLog.finalize();
        return res.status(statusCode).json(response);
      }

      // What: Process Server-Sent Events (SSE) for streaming responses.
      // Why: We must check for the asyncIterator Symbol to identify streams because
      // the orchestrator might force a fallback to a synchronous provider even if the client requested a stream.
      if (response && typeof response[Symbol.asyncIterator] === 'function') {
        return this.handleStreamingResponse(res, response, unifiedReq, reqLog, body);
      }

      // What: Handle synchronous (non-streaming) responses.
      // Why: For standard requests, we translate the normalized orchestrator output back
      // into the expected Anthropic shape and send it entirely in one HTTP response.
      logger.debug('Anthropic non-stream response sent successfully');
      const translatedResponse = translateResponse(FORMATS.ANTHROPIC, FORMATS.OPENAI, response, body);
      reqLog.logClientResponse(200, translatedResponse);
      await reqLog.finalize();
      return res.json(translatedResponse);
    } catch (err) {
      // What: Catch unhandled controller exceptions.
      // Why: Provides a final safety net for translation or protocol-level crashes.
      // Ensures the client receives a structured 500 error instead of a generic HTML error page
      // from the Express framework, preserving the API contract.
      logger.error('Unexpected completion error:', err);
      const errorBody = {
        error: {
          code: 'internal_server_error',
          message: err.message || String(err),
          httpStatus: 500,
        },
      };
      reqLog.logClientResponse(500, errorBody);
      await reqLog.finalize();
      return res.status(500).json(errorBody);
    }
  }

  // eslint-disable-next-line class-methods-use-this
  async handleStreamingResponse(res, response, unifiedReq, reqLog, body) {
    logger.debug('Starting Anthropic SSE response stream');

    // What: Set SSE headers.
    // Why: 'X-Accel-Buffering: no' is critical for Nginx environments. Without it,
    // reverse proxies will buffer the SSE chunks, destroying the real-time token streaming
    // experience and causing bursty, high-latency output on the client side.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    // State Machine Variables
    // Why: Anthropic's protocol requires explicit start/stop events for different content types.
    // We track `activeBlockType` to know when we're transitioning between 'thinking' (reasoning)
    // and 'text' blocks, enabling us to emit the correct content_block_stop/start boundaries.
    let messageStartSent = false;
    let activeBlockType = null;
    let currentBlockIndex = 0;
    const msgId = `msg_${Date.now()}`;
    let chunkCount = 0;

    const accumulator = new StreamAccumulator(msgId, unifiedReq.model);

    try {
      /* eslint-disable no-restricted-syntax */
      for await (const chunk of response) {
        chunkCount += 1;

        // Provider-side chunk is logged at the adapter level.

        accumulator.processChunk(chunk);

        // What: Emit the initial message_start event.
        // Why: The Anthropic SDK throws a protocol error if the stream doesn't strictly
        // begin with a `message_start` event containing base metadata. We wait for the
        // first chunk to ensure we have the upstream ID before emitting this prologue.
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

        // What: Handle thinking/reasoning content blocks.
        // Why: Anthropic natively supports Chain of Thought (CoT) via distinct blocks.
        // If the orchestrator provides reasoning content, we must transition the state
        // machine into 'thinking' mode, closing any previous blocks to satisfy the SDK's parser.
        if (delta.reasoning_content) {
          if (activeBlockType !== 'thinking') {
            if (activeBlockType !== null) {
              const stopEvent = `event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: currentBlockIndex,
              })}\n\n`;
              reqLog.appendStreamEvent('client', stopEvent);
              res.write(stopEvent);
              currentBlockIndex += 1;
            }
            const startEvent = `event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: currentBlockIndex,
              content_block: {
                type: 'thinking',
                thinking: '',
              },
            })}\n\n`;
            reqLog.appendStreamEvent('client', startEvent);
            res.write(startEvent);
            activeBlockType = 'thinking';
          }

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

        // What: Handle standard text content blocks.
        // Why: Operates symmetrically to thinking blocks. If the model transitions from
        // thinking to answering, we emit a stop for thinking and a start for text. This
        // segregation is mandatory for Anthropic's UI components to render correctly.
        if (delta.content) {
          if (activeBlockType !== 'text') {
            if (activeBlockType !== null) {
              const stopEvent = `event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: currentBlockIndex,
              })}\n\n`;
              reqLog.appendStreamEvent('client', stopEvent);
              res.write(stopEvent);
              currentBlockIndex += 1;
            }
            const startEvent = `event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: currentBlockIndex,
              content_block: {
                type: 'text',
                text: '',
              },
            })}\n\n`;
            reqLog.appendStreamEvent('client', startEvent);
            res.write(startEvent);
            activeBlockType = 'text';
          }

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

        // What: Process the stream completion signal.
        // Why: Once the upstream provider signals `finish_reason`, we must gracefully
        // close any open content blocks before emitting `message_delta` containing the
        // stop reason. Failing to close the block first results in SDK parse exceptions.
        if (choice.finish_reason) {
          if (activeBlockType !== null) {
            const stopEvent = `event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop',
              index: currentBlockIndex,
            })}\n\n`;
            reqLog.appendStreamEvent('client', stopEvent);
            res.write(stopEvent);
            activeBlockType = null;
          }

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

      // What: Ensure all blocks are closed.
      // Why: If the upstream stream died ungracefully without a finish_reason, we still
      // need to seal the currently open block to prevent lingering unclosed state in the client.
      if (activeBlockType !== null) {
        const stopEvent = `event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index: currentBlockIndex,
        })}\n\n`;
        reqLog.appendStreamEvent('client', stopEvent);
        res.write(stopEvent);
      }

      // What: Emit the final message_stop event.
      // Why: Anthropic's protocol mandates a final `message_stop` event to definitively
      // sever the semantic payload before the HTTP socket is closed.
      const messageStop = `event: message_stop\ndata: ${JSON.stringify({
        type: 'message_stop',
      })}\n\n`;
      reqLog.appendStreamEvent('client', messageStop);
      res.write(messageStop);
      logger.debug('Anthropic SSE response stream completed', { chunkCount });

      // What: Reconstruct and log the complete response.
      // Why: For audit and billing purposes, we recreate a cohesive response object
      // from the accumulated chunks and log it.
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
      // What: Handle mid-stream errors.
      // Why: If the stream crashes midway, HTTP headers are already sent, so we cannot
      // return a 500 status code. We silently terminate the socket but explicitly log
      // the abort to preserve the audit trail for debugging.
      logger.debug('Anthropic SSE response stream aborted or failed', { chunkCount, error: err.message });
      reqLog.logClientResponse(0, {
        _streamed: true,
        _aborted: true,
        _eventCount: chunkCount,
        error: err.message,
      });
    } finally {
      // What: Ensure resource cleanup.
      // Why: Always finalize the audit log and close the HTTP response to prevent socket leaks,
      // regardless of success or failure.
      await reqLog.finalize();
      res.end();
    }
    return res;
  }
}

export default AnthropicController;
