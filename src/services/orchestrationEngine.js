/* eslint-disable no-restricted-syntax, no-constant-condition */
import { resolveModel } from '../utils/ModelRouter.js';
import { executeWithRetry } from './retryExecutor.js';
import { logDebug } from '../utils/loggerHelpers.js';

/**
 * Updates the current request object with resolved model configuration.
 */
const updateRequestWithModelConfig = (currentReq, config) => {
  if (!currentReq.model) return currentReq;

  const resolved = resolveModel(currentReq.model, config.providers);
  if (!resolved) return currentReq;

  const { modelConfig } = resolved;
  return {
    ...currentReq,
    provider: resolved.provider,
    actualModelId: modelConfig.id,
    fallbackModel: modelConfig.fallback_model || currentReq.fallbackModel,
    thinking_supported: modelConfig.thinking_supported || currentReq.thinking_supported,
    thinkingEnabled: modelConfig.thinking_supported !== undefined
      ? modelConfig.thinking_supported
      : currentReq.thinkingEnabled,
    thinkingBudget: modelConfig.default_thinking_budget !== undefined
      ? modelConfig.default_thinking_budget
      : currentReq.thinkingBudget,
  };
};

/**
 * WHAT: Implements the outer fallback loop across providers.
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

  while (true) {
    currentReq = updateRequestWithModelConfig(currentReq, config);

    const { provider } = currentReq;
    const adapter = providerFactory.get(provider);

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

    if (result && result.triggerFallback) {
      logDebug(logger, 'Triggering fallback routing', {
        originalModel: unifiedReq.model,
        fallbackModel: currentReq.fallbackModel,
      });

      const nextModel = currentReq.fallbackModel;
      if (!resolveModel(nextModel, config.providers) && nextModel.includes('/')) {
        // Fall back to direct provider/model parsing if not explicitly defined in the map.
        const [p, ...rest] = nextModel.split('/');
        currentReq = {
          ...currentReq,
          model: nextModel,
          provider: p.trim(),
          actualModelId: rest.join('/').trim(),
          isFallback: true,
        };
      } else {
        currentReq = {
          ...currentReq,
          model: nextModel,
          isFallback: true,
        };
      }
      continue;
    }

    return result;
  }
};
