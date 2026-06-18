import { formatOpenAiSseError } from '../errors/envelope.js';
import { StreamAccumulator } from '../streaming/streamAccumulator.js';
import { BaseController } from './baseController.js';

/**
 * Protocol controller for the OpenAI-compatible ingress endpoints.
 */
export class OpenAIController extends BaseController {
  constructor(orchestrator) {
    super(orchestrator, 'openai');
  }

  /**
   * Main HTTP handler for OpenAI chat completion requests.
   */
  async handleCompletion(req, res) {
    return this.executeRequest(req, res, {
      protocolName: 'OpenAI',
      translateReq: (body) => ({
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
   * Handles the Server-Sent Events (SSE) stream for an OpenAI response.
   */
   
  async handleStream(res, response, reqLog) {
    this.logger.debug('Starting OpenAI SSE response stream');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

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
      this.emitStreamError(res, reqLog, err, formatOpenAiSseError, 'openai', chunkCount);
    } finally {
      await reqLog.finalize();
      res.end();
    }
    return res;
  }
}
