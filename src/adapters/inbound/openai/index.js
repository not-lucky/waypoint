import { formatOpenAiSseError } from '../../../domain/errors/envelope.js';
import { StreamAccumulator } from '../../../utils/streaming/streamAccumulator.js';
import { startSSEStream } from '../../../utils/streaming/sseSetup.js';
import { FORMATS } from '../../transforms/index.js';
import { BaseController } from '../base.js';

/**
 * Protocol controller for the OpenAI-compatible ingress endpoints.
 *
 * The upstream is OpenAI-compatible and the ingress is also OpenAI-shape,
 * so no body translation is required. Only the response format field
 * mapping (`max_tokens` → `maxTokens`, `stream` boolean coercion) is
 * performed in `translateReq`.
 *
 * Streaming responses use `data: {JSON}\n\n` framing followed by a
 * terminal `data: [DONE]\n\n` sentinel.
 *
 * @extends BaseController
 */
export class OpenAIController extends BaseController {
  /**
   * @param {import('../../../application/orchestrator.js').UnifiedOrchestrator} orchestrator -
   *   The shared orchestrator.
   */
  constructor(orchestrator) {
    super(orchestrator, 'openai');
  }

  /**
   * Entry point for the `/chat/completions` route. Delegates to
   * `executeRequest` with the OpenAI ingress format and an identity
   * translator (we accept OpenAI-shaped bodies directly).
   *
   * @async
   * @param {import('express').Request} req - Express request.
   * @param {import('express').Response} res - Express response.
   * @returns {Promise<import('express').Response>}
   */
  async handleCompletion(req, res) {
    return this.executeRequest(req, res, {
      protocolName: 'OpenAI',
      ingressFormat: FORMATS.OPENAI,
      translateReq: (body) => ({
        // Spread copies all client params, including extraBody.
        // Explicit mapping is not needed here as no structure change is required.
        ...body,
        messages: body.messages || [],
        maxTokens: body.max_tokens ?? body.max_completion_tokens,
        stream: Boolean(body.stream),
      }),
      handleStream: (resp, response, unifiedReq, reqLog) => (
        this.handleStream(resp, response, reqLog)
      ),
    });
  }

  /**
   * Streams the upstream response to the client as SSE frames.
   *
   * Side effects: writes `data: {...}\n\n` frames and a final `[DONE]`
   * sentinel, maintains a running accumulator for the debug log, and
   * emits an SSE error frame if the upstream throws mid-stream.
   *
   * @async
   * @param {import('express').Response} res - Express response.
   * @param {AsyncIterable<Object>} response - The async iterable of OpenAI-shaped chunks.
   * @param {Object} reqLog - Per-request debug logger.
   * @returns {Promise<import('express').Response>}
   */
  async handleStream(res, response, reqLog) {
    this.logger.debug('Starting OpenAI SSE response stream');

    startSSEStream(res);

    let chunkCount = 0;
    const accumulator = new StreamAccumulator();

    try {
      for await (const chunk of response) {
        chunkCount += 1;
        const sseData = `data: ${JSON.stringify(chunk)}\n\n`;

        accumulator.processChunk(chunk);
        reqLog.appendStreamEvent('client', sseData);
        res.write(sseData);
      }

      const doneMarker = 'data: [DONE]\n\n';
      reqLog.appendStreamEvent('client', doneMarker);
      res.write(doneMarker);
      this.logger.debug('OpenAI SSE response stream completed', { chunkCount });

      reqLog.logClientStreamSummary({
        _format: 'sse-json',
        _eventCount: chunkCount,
        summary: {
          ...accumulator.buildNormalizedResponse(),
          _streamed: true,
        },
      });
    } catch (err) {
      this.logger.debug('OpenAI SSE response stream aborted or failed', { chunkCount, error: err.message });
      this.emitStreamError(
        res,
        reqLog,
        err,
        formatOpenAiSseError,
        FORMATS.OPENAI,
        FORMATS.OPENAI,
        chunkCount,
      );
    } finally {
      await reqLog.finalize();
      res.end();
    }
    return res;
  }
}
