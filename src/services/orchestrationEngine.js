/* eslint-disable no-restricted-syntax, no-constant-condition */
import { resolveModel } from '../utils/ModelRouter.js';
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
  let currentReq = req;

  // Loop infinitely until either a successful completion is returned,
  // all retries/keys are exhausted, or an unsupported provider/error is thrown.
  while (true) {
    // Resolve model mapping from active config in a non-mutating way.
    if (currentReq.model) {
      const resolved = resolveModel(currentReq.model, config.providers);
      if (resolved) {
        const { modelConfig } = resolved;
        currentReq = {
          ...currentReq,
          provider: resolved.provider,
          actualModelId: modelConfig.id,
          fallbackModel: modelConfig.fallback_model || currentReq.fallbackModel,
          thinking_supported: modelConfig.thinking_supported
            || currentReq.thinking_supported,
          thinkingEnabled: modelConfig.thinking_supported !== undefined
            ? modelConfig.thinking_supported
            : currentReq.thinkingEnabled,
          thinkingBudget: modelConfig.default_thinking_budget !== undefined
            ? modelConfig.default_thinking_budget
            : currentReq.thinkingBudget,
        };
      }
    }

    const { provider } = currentReq;
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
      req: currentReq,
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
        fallbackModel: currentReq.fallbackModel,
      });

      let nextProvider = currentReq.provider;
      let nextActualModelId = currentReq.actualModelId;
      let nextThinkingSupported = currentReq.thinking_supported;
      let nextThinkingEnabled = currentReq.thinkingEnabled;
      let nextThinkingBudget = currentReq.thinkingBudget;
      let nextFallbackModel = currentReq.fallbackModel;

      // Attempt to resolve model specs for the fallback identifier.
      const resolved = resolveModel(currentReq.fallbackModel, config.providers);
      if (resolved) {
        const { modelConfig } = resolved;
        nextProvider = resolved.provider;
        nextActualModelId = modelConfig.id;
        nextFallbackModel = modelConfig.fallback_model || nextFallbackModel;
        nextThinkingSupported = modelConfig.thinking_supported || nextThinkingSupported;
        nextThinkingEnabled = modelConfig.thinking_supported !== undefined
          ? modelConfig.thinking_supported
          : nextThinkingEnabled;
        nextThinkingBudget = modelConfig.default_thinking_budget !== undefined
          ? modelConfig.default_thinking_budget
          : nextThinkingBudget;
      } else if (currentReq.fallbackModel.includes('/')) {
        // Fall back to direct provider/model parsing if not explicitly defined in the map.
        const [p, ...rest] = currentReq.fallbackModel.split('/');
        nextProvider = p.trim();
        nextActualModelId = rest.join('/').trim();
      }

      currentReq = {
        ...currentReq,
        model: currentReq.fallbackModel,
        provider: nextProvider,
        actualModelId: nextActualModelId,
        fallbackModel: nextFallbackModel,
        thinking_supported: nextThinkingSupported,
        thinkingEnabled: nextThinkingEnabled,
        thinkingBudget: nextThinkingBudget,
        isFallback: true, // Set flag to prevent infinite fallback loop.
      };
      continue;
    }

    return result;
  }
};
