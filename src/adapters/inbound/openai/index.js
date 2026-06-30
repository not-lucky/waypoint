import { formatOpenAiSseError } from '../../../domain/errors/envelope.js';
import { StreamAccumulator } from '../../../utils/streaming/streamAccumulator.js';
import { startSSEStream } from '../../../utils/streaming/sseSetup.js';
import { FORMATS } from '../../transforms/index.js';
import { BaseController } from '../base.js';

/**
 * Protocol controller for the OpenAI-compatible ingress endpoints.
 * Upstream is OpenAI-compatible; ingress is OpenAI-shape; no translation needed.
 */
export class OpenAIController extends BaseController {
  constructor(orchestrator) {
    super(orchestrator, 'openai');
  }

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
