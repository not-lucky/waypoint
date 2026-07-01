/**
 * @fileoverview Outer fallback orchestration engine.
 * Handles fallbacks between different LLM model configurations and providers
 * in case of key exhaustion or failures in the primary provider.
 * @module services/orchestrationEngine
 */

 
import { resolveModel } from '../domain/routing/router.js';
import { applyModelConfigToRequest } from '../domain/routing/transformer.js';
import { executeWithRetry } from './retry/engine.js';
import { getAppLogger } from '../infrastructure/logging/logger.js';

/**
 * Module-level logger for the outer fallback loop.
 * @type {Object}
 */
const logger = getAppLogger('orchestration');

/**
 * Updates the current request object with resolved model configuration.
 *
 * Performs a fresh `resolveModel` call (unless one was already cached on
 * the request), then projects the resolved provider/model id plus any
 * model-level settings onto the request via `applyModelConfigToRequest`.
 * If `currentReq.model` is empty or cannot be resolved, the request is
 * returned unchanged so the caller can surface an `unsupportedProvider`
 * error rather than a misleading null deref.
 *
 * @param {Object} currentReq - The current normalized request object.
 * @param {Object} config - The active application configuration object.
 * @returns {Object} Updated request object with resolved provider and model configs.
 */
const updateRequestWithModelConfig = (currentReq, config) => {
  if (!currentReq.model) return currentReq;

  const resolved = currentReq.resolvedModel || resolveModel(currentReq.model, config.providers);
  if (!resolved) return currentReq;

  const { modelConfig } = resolved;

  const base = currentReq.clientParams ? { ...currentReq.clientParams } : { ...currentReq };

  base.model = currentReq.model;
  base.isFallback = currentReq.isFallback;

  let req = {
    ...base,
    provider: resolved.provider,
    modelid: modelConfig.modelid,
  };

  req = applyModelConfigToRequest(req, modelConfig);
  req.clientParams = base;

  return req;
};

/**
 * Prepares request state for fallback transition.
 *
 * The function:
 * 1. Sets `model` to the fallback identifier and `isFallback = true`.
 * 2. Clears `resolvedModel` so the engine performs a fresh resolve.
 * 3. If the new model identifier does not resolve via `resolveModel` (i.e.
 *    it is not in the configured model map) but contains a slash, parses
 *    the segment as a `provider/modelid` pair so adapters can route to a
 *    provider that has no explicit model declaration.
 *
 * @param {Object} currentReq - The current request state.
 * @param {string} nextModel - The fallback model configuration.
 * @param {Object} config - The application configuration.
 * @returns {Object} Next request state.
 */
const prepareNextRequestState = (currentReq, nextModel, config) => {
  const nextReq = {
    ...currentReq,
    model: nextModel,
    isFallback: true,
  };
  delete nextReq.resolvedModel;

  if (!resolveModel(nextModel, config.providers) && nextModel.includes('/')) {
    // Fall back to direct provider/model parsing if not explicitly defined in the map.
    const firstSlashIndex = nextModel.indexOf('/');
    nextReq.provider = nextModel.substring(0, firstSlashIndex).trim();
    nextReq.modelid = nextModel.substring(firstSlashIndex + 1).trim();
  }

  return nextReq;
};

/**
 * Runs the outer orchestration loop.
 *
 * Iteratively attempts completion requests, executing the retry loop on
 * the current provider. If retry loop reports exhaustion and a fallback
 * model is configured, triggers a fallback transition to the next
 * provider/model and continues; otherwise returns the error result.
 *
 * Cycle protection: a `visitedModels` Set guards against infinite
 * fallback loops (A → B → A → B …). The set is keyed by the model
 * identifier used at each iteration; a repeated identifier triggers an
 * `infiniteFallbackLoop` error with HTTP status 508.
 *
 * Provider resolution: if the current model resolves to a provider that
 * the factory does not know, the loop returns an `unsupportedProvider`
 * error rather than throwing.
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
  abortController,
  requestLog,
  retryLimit,
  onStreamResponse,
}) => {
  let currentReq = req;
  const visitedModels = new Set();

  while (true) {
    currentReq = updateRequestWithModelConfig(currentReq, config);

    // Prevent infinite fallback loops
    const modelKey = currentReq.model || currentReq.modelid;
    if (visitedModels.has(modelKey)) {
      logger.error('Infinite fallback loop detected, aborting request', { modelCycle: Array.from(visitedModels), failingModel: modelKey });
      return {
        error: {
          code: 'infiniteFallbackLoop',
          message: `Fallback routing cycle detected. Aborting to prevent infinite loop.`,
          provider: currentReq.provider,
          httpStatus: 508,
        },
      };
    }
    visitedModels.add(modelKey);

    const { provider } = currentReq;
    const adapter = providerFactory.get(provider);

    if (!adapter) {
      return {
        error: {
          code: 'unsupportedProvider',
          message: `Provider '${provider}' is not supported or configured.`,
          provider,
          httpStatus: 400,
        },
      };
    }

     
    const result = await executeWithRetry({
      provider,
      req: currentReq,
      adapter,
      keyRegistry,
      abortController,
      requestLog,
      retryLimit,
      onStreamResponse,
    });

    if (result && result.triggerFallback) {
      logger.debug('Triggering fallback routing', {
        originalModel: unifiedReq.model,
        fallbackModel: currentReq.fallbackModel,
      });

      currentReq = prepareNextRequestState(currentReq, currentReq.fallbackModel, config);
      continue;
    }

    return result;
  }
};
