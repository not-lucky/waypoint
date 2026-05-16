import { resolveModel } from '../utils/ModelRouter.js';
import { transformRequest } from '../utils/RequestTransformer.js';
import { getAppLogger } from '../utils/logger.js';
import { createRequestLog } from '../utils/requestLogger.js';
import { StreamAccumulator } from '../utils/StreamAccumulator.js';

const logger = getAppLogger('openai');

/**
 * Protocol controller for the OpenAI-compatible ingress endpoints.
 *
 * ARCHITECTURE & RATIONALE:
 * We enforce a strict boundary between ingress protocols and the core UnifiedOrchestrator.
 * By isolating HTTP nuances, Express req/res lifecycles, and OpenAI-specific schema
 * parsing within this controller, the orchestrator remains completely protocol-agnostic.
 * This ensures that adding future protocols (e.g., Anthropic native, gRPC) won't pollute
 * the core routing, fallback, or translation logic.
 *
 * WHAT:
 * Translates inbound OpenAI chat completion requests into UnifiedRequest format,
 * resolves model configuration and header overrides, dispatches to the orchestrator,
 * and returns the NormalizedResponse directly (already OpenAI-shaped from adapters).
 *
 * SIDE EFFECTS & EDGE CASES:
 * - Mutates the unified internal request by injecting resolved model configs and header overrides.
 * - Takes over the Express response stream entirely if the underlying provider returns
 *   an async generator.
 *
 * Mounted on: /openai/chat/completions, /openai/v1/chat/completions
 */
export class OpenAIController {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
  }

  /**
   * Main HTTP handler for OpenAI chat completion requests.
   *
   * RATIONALE:
   * This method acts as the translation layer between the outside world's OpenAI format
   * and our internal Unified format. It also acts as the ultimate safety net, ensuring
   * that downstream orchestrator failures or network timeouts never crash the Node process
   * and always return a well-formed JSON or SSE response to the client.
   *
   * @param {Object} req - Express request object.
   * @param {Object} res - Express response object.
   */
  async handleCompletion(req, res) {
    // RATIONALE: Instantiate logging as early as possible so that even early validation
    // or mapping errors can be tied to a specific request ID for debugging.
    // WHAT: Create per-request debug log (no-op if disabled in config). This allows
    // deep tracing of raw payloads before they undergo translation.
    const reqLog = createRequestLog(req, this.orchestrator.config);

    try {
      const body = req.body || {};
      const providersConfig = this.orchestrator.config?.providers || {};

      // RATIONALE: OpenAI clients often have conflicting fields due to API version drift
      // (e.g., max_tokens vs max_completion_tokens). We isolate this ambiguity at the edge
      // by coalescing these into a single canonical source of truth for downstream processing,
      // protecting downstream layers from conditional checks.
      // WHAT: Build the unified internal request from the OpenAI payload. max_tokens and
      // max_completion_tokens are both accepted; nullish coalescing picks whichever is present.
      const baseReq = {
        model: body.model,
        messages: body.messages || [],
        temperature: body.temperature,
        maxTokens: body.max_tokens ?? body.max_completion_tokens,
        stream: body.stream || false,
        isFallback: false,
      };

      // RATIONALE: Header-based routing and configuration allows clients to bypass static configs
      // dynamically (e.g., forcing a specific provider or adjusting thinking budgets) without
      // changing the core payload. We do this here instead of the orchestrator to keep the HTTP
      // header parsing out of the generic processing loop.
      // WHAT: Resolve model config (provider, actualModelId, fallback, thinking defaults)
      // then apply header-level overrides (thinking budget, temperature) in a non-mutating way.
      const resolved = resolveModel(body.model, providersConfig);
      const { unifiedReq, cleanRawReq } = transformRequest(baseReq, req, resolved);

      logger.debug('OpenAI completion request received', {
        model: body.model,
        messagesCount: body.messages?.length || 0,
        stream: body.stream || false,
        resolvedProvider: unifiedReq.provider,
        resolvedModel: unifiedReq.actualModelId,
      });

      // WHAT: Dispatch the normalized request to the core engine.
      const response = await this.orchestrator.executeCompletion(unifiedReq, cleanRawReq, reqLog);

      // RATIONALE: We rely on the orchestrator to catch provider errors and return them
      // as an { error: {...} } object rather than throwing. This prevents costly stack trace
      // generation and allows us to check and map the httpStatus for the client response
      // cleanly without catching exceptions.
      if (response?.error) {
        logger.debug('OpenAI completion failed', { error: response.error });
        const statusCode = response.error.httpStatus || 500;
        reqLog.logClientResponse(statusCode, response);
        await reqLog.finalize();
        return res.status(statusCode).json(response);
      }

      // RATIONALE: Node.js async iterators are fundamentally different from Express
      // chunked responses. We must manually bridge them to support Server-Sent Events (SSE).
      // WHAT: If the response is a stream (async generator), handle as SSE (Server-Sent Events).
      if (response && typeof response[Symbol.asyncIterator] === 'function') {
        return this.handleStream(res, response, reqLog);
      }

      // RATIONALE: For non-streaming requests, the orchestrator guarantees that the response
      // payload matches the OpenAI schema. We simply serialize it and close the request.
      // WHAT: NormalizedResponse is already OpenAI-shaped — no translation needed.
      logger.debug('OpenAI non-stream response sent successfully');
      reqLog.logClientResponse(200, response);
      await reqLog.finalize();
      return res.json(response);
    } catch (err) {
      // RATIONALE: This catch block is the final safety net for the controller.
      // It handles catastrophic failures (e.g., synchronous errors in parsing,
      // missing dependencies) and guarantees we never leak unhandled promise
      // rejections resulting in hung client requests.
      // WHAT: Catch-all for unexpected errors (e.g. orchestrator throws instead
      // of returning error).
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

  /**
   * Handles the Server-Sent Events (SSE) stream for an OpenAI response.
   */
  // eslint-disable-next-line class-methods-use-this
  async handleStream(res, response, reqLog) {
    logger.debug('Starting OpenAI SSE response stream');

    // EDGE CASE / RATIONALE: Standard reverse proxies (like NGINX) will buffer
    // chunked responses, destroying the real-time UX of LLM streaming.
    // 'X-Accel-Buffering: no' forces the proxy to flush each chunk to the client instantly.
    // WHAT: Set standard headers for event streams to disable buffering and allow
    // live streaming.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    let chunkCount = 0;
    const accumulator = new StreamAccumulator();

    try {
      /* eslint-disable no-restricted-syntax */
      // WHAT: Iterate over each chunk produced by the orchestrator/adapter stream.
      for await (const chunk of response) {
        chunkCount += 1;
        const sseData = `data: ${JSON.stringify(chunk)}\n\n`;

        accumulator.processChunk(chunk);

        // WHAT: Log client stream event.
        reqLog.appendStreamEvent('client', sseData);

        res.write(sseData);
      }
      /* eslint-enable no-restricted-syntax */

      // RATIONALE: The '[DONE]' marker is a mandatory protocol requirement for OpenAI clients.
      // Without it, clients like the official Python/Node SDKs will hang indefinitely
      // waiting for more chunks until they hit a timeout.
      // WHAT: Signal stream termination using standard OpenAI [DONE] indicator,
      // ensuring client libraries know the stream is cleanly closed.
      const doneMarker = 'data: [DONE]\n\n';
      reqLog.appendStreamEvent('client', doneMarker);
      res.write(doneMarker);
      logger.debug('OpenAI SSE response stream completed', { chunkCount });

      // WHAT: Log client response summary for streaming.
      reqLog.logClientStreamSummary({
        _format: 'sse-json',
        _eventCount: chunkCount,
        summary: {
          ...accumulator.buildNormalizedResponse(),
          _streamed: true,
        },
      });
    } catch (err) {
      logger.debug('OpenAI SSE response stream aborted or failed', { chunkCount, error: err.message });
      reqLog.logClientResponse(0, {
        _streamed: true,
        _aborted: true,
        _eventCount: chunkCount,
        error: err.message,
      });

      // RATIONALE: When streaming, HTTP 200 headers have already been sent.
      // If an error occurs mid-stream, we cannot retroactively change the status code
      // to 500. The only safe action is to log the failure and forcefully terminate
      // the connection so the client doesn't hang.
      // WHAT: Handle client disconnect or unexpected stream errors silently.
    } finally {
      // RATIONALE: Failing to call res.end() guarantees a memory leak and exhausted
      // connection pools.
      // WHAT: Always end the response stream to clean up connection resources.
      await reqLog.finalize();
      res.end();
    }
    return res;
  }
}

export default OpenAIController;
