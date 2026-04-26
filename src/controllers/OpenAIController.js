import { resolveModel, applyModelConfig, applyHeaderOverrides } from '../utils/modelResolver.js';
import { getAppLogger } from '../utils/logger.js';
import { createRequestLog } from '../utils/requestLogger.js';

const logger = getAppLogger('openai');

/**
 * Protocol controller for the OpenAI-compatible ingress endpoints.
 * Translates inbound OpenAI chat completion requests into UnifiedRequest format,
 * resolves model configuration and header overrides, dispatches to the orchestrator,
 * and returns the NormalizedResponse directly (already OpenAI-shaped from adapters).
 *
 * We implement controller boundaries specific to ingress protocols so the core
 * orchestrator doesn't need to know anything about Express HTTP nuances or client schemas.
 *
 * Mounted on: /openai/chat/completions, /openai/v1/chat/completions
 */
export class OpenAIController {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
  }

  async handleCompletion(req, res) {
    // Create per-request debug log (no-op if disabled in config).
    // This allows deep tracing of raw payloads before they undergo translation.
    const reqLog = createRequestLog(req, this.orchestrator.config);

    try {
      const body = req.body || {};
      const providersConfig = this.orchestrator.config?.providers || {};

      // Build the unified internal request from the OpenAI payload.
      // We normalize differing OpenAI fields (e.g. max_tokens vs max_completion_tokens) 
      // into a single canonical source of truth for downstream processing.
      // max_tokens and max_completion_tokens are both accepted (OpenAI uses either
      // depending on API version); nullish coalescing picks whichever is present.
      const unifiedReq = {
        model: body.model,
        messages: body.messages || [],
        temperature: body.temperature,
        maxTokens: body.max_tokens ?? body.max_completion_tokens,
        stream: body.stream || false,
        isFallback: false,
      };

      // Resolve model config (provider, actualModelId, fallback, thinking defaults)
      // then apply header-level overrides (thinking budget, temperature).
      // We do this here instead of the orchestrator to keep the HTTP header
      // parsing out of the generic processing loop.
      applyModelConfig(unifiedReq, resolveModel(body.model, providersConfig));
      const cleanRawReq = applyHeaderOverrides(unifiedReq, req);

      logger.debug('OpenAI completion request received', {
        model: body.model,
        messagesCount: body.messages?.length || 0,
        stream: body.stream || false,
        resolvedProvider: unifiedReq.provider,
        resolvedModel: unifiedReq.actualModelId,
      });

      const response = await this.orchestrator.executeCompletion(unifiedReq, cleanRawReq, reqLog);

      // Orchestrator returns { error: {...} } on failure rather than throwing,
      // so we check and map the httpStatus for the client response cleanly without catching exceptions.
      if (response?.error) {
        logger.debug('OpenAI completion failed', { error: response.error });
        const statusCode = response.error.httpStatus || 500;
        reqLog.logClientResponse(statusCode, response);
        await reqLog.finalize();
        return res.status(statusCode).json(response);
      }

      // If the response is a stream (async generator), handle as SSE (Server-Sent Events).
      // This streaming logic bridges the Node.js async iterator pattern with the Express HTTP chunked response.
      if (response && typeof response[Symbol.asyncIterator] === 'function') {
        logger.debug('Starting OpenAI SSE response stream');
        // Set standard headers for event streams to disable buffering and allow live streaming,
        // specifically bypassing NGINX/proxy buffering via X-Accel-Buffering.
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');

        let chunkCount = 0;
        try {
          /* eslint-disable no-restricted-syntax */
          // Iterate over each chunk produced by the orchestrator/adapter stream
          for await (const chunk of response) {
            chunkCount += 1;
            const sseData = `data: ${JSON.stringify(chunk)}\n\n`;

            // Log both directions of the stream event
            reqLog.appendStreamEvent('provider', chunk);
            reqLog.appendStreamEvent('client', sseData);

            res.write(sseData);
          }
          /* eslint-enable no-restricted-syntax */
          // Signal stream termination using standard OpenAI [DONE] indicator,
          // ensuring client libraries know the stream is cleanly closed.
          const doneMarker = 'data: [DONE]\n\n';
          reqLog.appendStreamEvent('client', doneMarker);
          res.write(doneMarker);
          logger.debug('OpenAI SSE response stream completed', { chunkCount });

          // Log client response summary for streaming.
          reqLog.logClientResponse(200, {
            _streamed: true,
            _format: 'sse',
            _eventCount: chunkCount,
          });
        } catch (err) {
          logger.debug('OpenAI SSE response stream aborted or failed', { chunkCount, error: err.message });
          reqLog.logClientResponse(0, {
            _streamed: true,
            _aborted: true,
            _eventCount: chunkCount,
            error: err.message,
          });
          // Handle client disconnect or unexpected stream errors silently.
          // In a streaming context, the HTTP headers are already sent, so we can't emit a 500 status.
        } finally {
          // Always end the response stream to clean up connection resources
          await reqLog.finalize();
          res.end();
        }
        return res;
      }

      // NormalizedResponse is already OpenAI-shaped — no translation needed
      logger.debug('OpenAI non-stream response sent successfully');
      reqLog.logClientResponse(200, response);
      await reqLog.finalize();
      return res.json(response);
    } catch (err) {
      // Catch-all for unexpected errors (e.g. orchestrator throws instead of returning error).
      // Guarantees we never leak unhandled promise rejections resulting in hung client requests.
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
}

export default OpenAIController;