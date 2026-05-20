/**
 * @fileoverview Outer fallback orchestration engine.
 * Handles fallbacks between different LLM model configurations and providers
 * in case of key exhaustion or failures in the primary provider.
 * @module services/orchestrationEngine
 */

/* eslint-disable no-restricted-syntax, no-constant-condition */
import { resolveModel } from '../utils/ModelRouter.js';
import { executeWithRetry } from './retryExecutor.js';
import { logDebug } from '../utils/loggerHelpers.js';

/**
 * Updates the current request object with resolved model configuration.
 *
 * @param {Object} currentReq - The current normalized request object.
 * @param {Object} config - The active application configuration object.
 * @returns {Object} Updated request object with resolved provider and model configs.
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
 * Runs the outer orchestration loop.
 * Iteratively attempts completion requests, executing the retry loop on the current provider.
 * If retry loop reports exhaustion and fallback is defined, triggers fallback transition
 * to the next provider/model.
 *
 * @param {Object} options - Orchestration parameters.
 * @param {Object} options.req - Cloned, mutable request state object.
 * @param {Object} options.unifiedReq - Original immutable unified request object.
 * @param {Object} options.keyRegistry - Stateful API key registry instance.
 * @param {Object} options.providerFactory - Factory for instantiating provider adapters.
 * @param {Object} options.config - Current configuration settings.
 * @param {Object|null} options.logger - Logger instance.
 * @param {AbortController} options.abortController - Abort controller for tracking aborts.
 * @param {Object|null} options.requestLog - Request logger telemetry recorder.
 * @param {number} options.retryLimit - Max retry count for each provider key rotation block.
 * @param {Function} options.onStreamResponse - Callback triggered when streaming starts.
 * @returns {Promise<Object|AsyncGenerator>} Mapped adapter output or error status.
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
