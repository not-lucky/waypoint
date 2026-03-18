import { resolveModel, applyModelConfig, applyHeaderOverrides } from '../utils/modelResolver.js';

/**
 * Protocol controller for the OpenAI-compatible ingress endpoints.
 * Translates inbound OpenAI chat completion requests into UnifiedRequest format,
 * resolves model configuration and header overrides, dispatches to the orchestrator,
 * and returns the NormalizedResponse directly (already OpenAI-shaped from adapters).
 *
 * Mounted on: /openai/chat/completions, /openai/v1/chat/completions
 */
export class OpenAIController {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
  }

  async handleCompletion(req, res) {
    try {
      const body = req.body || {};
      const providersConfig = this.orchestrator.config?.providers || {};

      // Build the unified internal request from the OpenAI payload.
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
      // then apply header-level overrides (thinking budget, temperature)
      applyModelConfig(unifiedReq, resolveModel(body.model, providersConfig));
      const cleanRawReq = applyHeaderOverrides(unifiedReq, req);

      const response = await this.orchestrator.executeCompletion(unifiedReq, cleanRawReq);

      // Orchestrator returns { error: {...} } on failure rather than throwing,
      // so we check and map the httpStatus for the client response
      if (response?.error) {
        return res.status(response.error.httpStatus || 500).json(response);
      }

      // If the response is a stream (async generator), handle as SSE (Server-Sent Events)
      if (response && typeof response[Symbol.asyncIterator] === 'function') {
        // Set standard headers for event streams to disable buffering and allow live streaming
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');

        try {
          /* eslint-disable no-restricted-syntax */
          // Iterate over each chunk produced by the orchestrator/adapter stream
          for await (const chunk of response) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          /* eslint-enable no-restricted-syntax */
          // Signal stream termination using standard OpenAI [DONE] indicator
          res.write('data: [DONE]\n\n');
        } catch (err) {
          // Handle client disconnect or unexpected stream errors silently
        } finally {
          // Always end the response stream to clean up connection resources
          res.end();
        }
        return res;
      }

      // NormalizedResponse is already OpenAI-shaped — no translation needed
      return res.json(response);
    } catch (err) {
      // Catch-all for unexpected errors (e.g. orchestrator throws instead of returning error)
      this.orchestrator.logger?.error('Unexpected completion error:', err);
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

export default OpenAIController;
