/* eslint-disable no-restricted-syntax, no-constant-condition */
import { resolveModel, applyModelConfig } from '../utils/modelResolver.js';
import { executeWithRetry } from './retryExecutor.js';
import { logDebug } from '../utils/loggerHelpers.js';

/**
 * WHAT: Implements the outer fallback loop across providers.
 * WHY: Resolves the model routing configuration, checks adapter support, and initiates
 * execution. Fails over to fallback models if primary provider runs out of keys or errors out.
 */
export const runOrchestrationLoop = async ({
  req,
  unifiedReq,
  keyRegistry,
  providerFactory,
  config,
  logger,
  abortController,
  requestLog,
  retryLimit,
  onStreamResponse,
}) => {
  // Loop infinitely until either a successful completion is returned,
  // all retries/keys are exhausted, or an unsupported provider/error is thrown.
  while (true) {
    // Resolve upstream model provider mapping from active config (if model exists).
    if (req.model) {
      applyModelConfig(req, resolveModel(req.model, config.providers));
    }

    const { provider } = req;
    // Retrieve the registered provider adapter (e.g. GeminiAdapter, AnthropicAdapter).
    const adapter = providerFactory.get(provider);

    // Return 400 Bad Request if the target provider is not supported or missing in configuration.
    if (!adapter) {
      return {
        error: {
          code: 'unsupported_provider',
          message: `Provider '${provider}' is not supported or configured.`,
          provider,
          httpStatus: 400,
        },
      };
    }

    // Execute key rotation and exponential backoff retry flow on the current provider.
    // eslint-disable-next-line no-await-in-loop
    const result = await executeWithRetry({
      provider,
      req,
      adapter,
      keyRegistry,
      abortController,
      requestLog,
      retryLimit,
      logger,
      onStreamResponse,
    });

    // If the executor returns a triggerFallback signal, we pivot to the fallback provider/model.
    if (result && result.triggerFallback) {
      logDebug(logger, 'Triggering fallback routing', {
        originalModel: unifiedReq.model,
        fallbackModel: req.fallbackModel,
      });

      // Attempt to resolve model specs for the fallback identifier.
      const resolved = resolveModel(req.fallbackModel, config.providers);
      if (resolved) {
        applyModelConfig(req, resolved);
      } else if (req.fallbackModel.includes('/')) {
        // Fall back to direct provider/model parsing if not explicitly defined in the map.
        const [p, ...rest] = req.fallbackModel.split('/');
        req.provider = p.trim();
        req.actualModelId = rest.join('/').trim();
      }
      req.model = req.fallbackModel;
      req.isFallback = true; // Set flag to prevent infinite fallback loop.
      continue;
    }

    return result;
  }
};
