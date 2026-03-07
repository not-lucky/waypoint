/* eslint-disable no-restricted-syntax, no-constant-condition, no-await-in-loop, no-continue */

/**
 * Helper to resolve the correct model configuration from the providers configuration object.
 * Parses modelName (e.g. "openai/gpt-4o" or "gemini-1.5-flash") and matches it against
 * configured models, aliases, or actual_model_ids.
 *
 * @param {string} modelName - The identifier of the model to resolve.
 * @param {Object} providersConfig - The providers section of the loaded configuration.
 * @returns {Object|null} Object containing resolved provider name and model config, or null.
 */
const resolveModelConfig = (modelName, providersConfig = {}) => {
  if (!modelName) return null;

  let resolvedProvider = null;
  let resolvedModelConfig = null;

  // Resolve by provider/model-id prefix format if present (e.g., "openai/gpt-4o")
  if (modelName.includes('/')) {
    const [providerPart, ...rest] = modelName.split('/');
    const modelPart = rest.join('/').trim();
    const cleanProvider = providerPart.trim();

    const providerConf = providersConfig[cleanProvider];
    if (providerConf) {
      resolvedProvider = cleanProvider;
      const models = providerConf.models || [];
      resolvedModelConfig = models.find(
        (m) => m.id === modelPart || m.aliases?.includes(modelPart),
      ) || models.find((m) => m.actual_model_id === modelPart)
        || { id: modelPart, actual_model_id: modelPart };
    }
  }

  // If we couldn't resolve it via provider/model-id format, search all providers for a match
  if (!resolvedProvider || !resolvedModelConfig) {
    for (const [pName, pConf] of Object.entries(providersConfig)) {
      const models = pConf.models || [];
      const match = models.find(
        (m) => m.id === modelName || m.aliases?.includes(modelName),
      );
      if (match) {
        resolvedProvider = pName;
        resolvedModelConfig = match;
        break;
      }
    }
  }

  if (resolvedProvider && resolvedModelConfig) {
    return {
      provider: resolvedProvider,
      modelConfig: resolvedModelConfig,
    };
  }

  return null;
};

/**
 * Helper to parse a fallback model identifier (e.g., "openai/gpt-4o") and retrieve its
 * corresponding provider name and actual_model_id (checking matching ID or aliases).
 *
 * @param {string} fallbackModel - Fallback model string in "provider/model-id" format.
 * @param {Object} providersConfig - The providers configuration object.
 * @returns {Object|null} Parsed provider and resolved actualModelId, or null if input is empty.
 */
const resolveFallbackModel = (fallbackModel, providersConfig = {}) => {
  if (!fallbackModel) return null;
  const [fallbackProvider, ...rest] = fallbackModel.split('/');
  const fallbackModelId = rest.join('/').trim();
  const cleanProvider = fallbackProvider.trim();

  let actualModelId = fallbackModelId;
  const providerConf = providersConfig[cleanProvider];
  if (providerConf) {
    const models = providerConf.models || [];
    const match = models.find(
      (m) => m.id === fallbackModelId || m.aliases?.includes(fallbackModelId),
    ) || models.find((m) => m.actual_model_id === fallbackModelId);
    if (match) {
      actualModelId = match.actual_model_id || match.id;
    }
  }
  return { provider: cleanProvider, actualModelId };
};

export class UnifiedOrchestrator {
  constructor(keyRegistry, providerFactory, config = {}) {
    this.keyRegistry = keyRegistry;
    this.providerFactory = providerFactory;
    this.config = config;
  }

  /**
   * Executes LLM completion by dispatching the request to the configured provider adapter,
   * handling key rotation, retries, overrides, and automatic fallback routing.
   *
   * @param {Object} unifiedReq - The normalized request payload.
   * @param {Object} rawReq - The raw Express request context.
   * @returns {Promise<Object>} Normalized completion result or error object.
   */
  async executeCompletion(unifiedReq, rawReq) {
    let req = { ...unifiedReq };

    // Default fallback status to false if not explicitly provided
    if (req.isFallback === undefined) {
      req.isFallback = false;
    }

    // Apply header-based overrides if rawReq is provided and has headers
    if (rawReq && rawReq.headers) {
      const thinkingLevelHeader = rawReq.headers['x-gateway-thinking-level'];
      if (thinkingLevelHeader) {
        const level = thinkingLevelHeader.toLowerCase();
        req.thinkingLevel = level;
        req.thinkingEnabled = true;

        const budgets = { low: 1024, medium: 2048, high: 4096 };
        if (req.thinkingBudget === undefined && budgets[level]) {
          req.thinkingBudget = budgets[level];
        }
      }

      const tempHeader = rawReq.headers['x-gateway-temperature'];
      if (tempHeader) {
        const parsedTemp = parseFloat(tempHeader);
        if (!Number.isNaN(parsedTemp)) {
          req.temperature = parsedTemp;
        }
      }
    }

    const retryLimit = this.config.gateway?.global_retry_limit ?? 3;

    // Create an abort signal and listen to the request/response close event.
    // NOTE: Do NOT listen to rawReq.on('close') directly on POST requests. Express's
    // body-parser (express.json()) fully reads and ends the request stream, which
    // causes Node.js to emit 'close' on rawReq immediately after parsing, before
    // any response is generated.
    // Instead, check rawReq.res and listen to the response's 'close' event, aborting
    // only if the response has not successfully finished (i.e. !res.writableEnded).
    const abortController = new AbortController();
    if (rawReq) {
      const target = rawReq.res || rawReq;
      if (typeof target.on === 'function') {
        target.on('close', () => {
          if (rawReq.res) {
            if (!rawReq.res.writableEnded) {
              abortController.abort();
            }
          } else {
            abortController.abort();
          }
        });
      }
    }

    // Outer loop to handle fallbacks
    while (true) {
      // Resolve provider and actualModelId from config if model is specified
      if (req.model) {
        const resolved = resolveModelConfig(req.model, this.config.providers);
        if (resolved) {
          const { provider: resolvedProvider, modelConfig } = resolved;
          req.provider = resolvedProvider;
          req.actualModelId = modelConfig.actual_model_id || modelConfig.id;

          if (modelConfig.fallback_model && !req.fallbackModel) {
            req.fallbackModel = modelConfig.fallback_model;
          }

          if (modelConfig.thinking_supported) {
            req.thinking_supported = true;
            if (
              req.thinkingBudget === undefined
              && modelConfig.default_thinking_budget !== undefined
            ) {
              req.thinkingBudget = modelConfig.default_thinking_budget;
            }
          }
        }
      }

      const { provider } = req;
      const adapter = this.providerFactory.get(provider);

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

      let attempt = 0;
      let triggerFallback = false;

      // Inner loop for key rotation/retries
      while (attempt < retryLimit) {
        if (abortController.signal.aborted) {
          return {
            error: {
              code: 'request_cancelled',
              message: 'Request was cancelled by the client.',
              provider,
              httpStatus: 499,
            },
          };
        }

        const apiKey = this.keyRegistry.getKey(provider);

        if (!apiKey) {
          // If no active keys are available:
          // A. If this is already a fallback dispatch, fail immediately with 503
          if (req.isFallback) {
            return this.buildAllKeysExhaustedError(provider);
          }

          // B. If a fallback model is configured, transition and break to restart the outer loop
          if (req.fallbackModel) {
            const resolved = resolveFallbackModel(req.fallbackModel, this.config.providers);
            req = {
              ...req,
              provider: resolved.provider,
              actualModelId: resolved.actualModelId,
              model: req.fallbackModel,
              isFallback: true,
            };
            triggerFallback = true;
            break;
          }

          // C. If no fallback is configured, break the inner loop and fall through to return 503
          break;
        }

        attempt += 1;

        try {
          const response = await adapter.generateCompletion(req, apiKey, abortController.signal);
          this.keyRegistry.flagSuccess(provider, apiKey);
          return response;
        } catch (error) {
          const statusCode = error?.status || error?.statusCode || error?.response?.status || 500;
          this.keyRegistry.flagFailure(provider, apiKey, statusCode);

          // Log each retry: attempt N of global_retry_limit, provider name, failure reason
          const failureReason = error?.message || String(error);
          console.warn(
            `Attempt ${attempt} of ${retryLimit} for provider '${provider}' failed. Reason: ${failureReason}`,
          );
        }
      }

      // If we flagged fallback transition inside the retry loop, restart outer loop
      if (triggerFallback) {
        continue;
      }

      // Check if fallback is configured and this isn't already a fallback request
      // (Handles fallback transition when keys fail/rate limit rather than returning
      // null initially)
      if (req.fallbackModel && !req.isFallback) {
        const resolved = resolveFallbackModel(req.fallbackModel, this.config.providers);
        req = {
          ...req,
          provider: resolved.provider,
          actualModelId: resolved.actualModelId,
          model: req.fallbackModel,
          isFallback: true,
        };
        continue;
      }

      // On loop exhaustion: return 503 NormalizedError {code:'all_keys_exhausted'}
      return this.buildAllKeysExhaustedError(provider);
    }
  }

  /**
   * Helper to build the normalized 503 all_keys_exhausted error payload, calculating
   * the earliest cooldown remainder across the provider's keys.
   *
   * @param {string} provider - The name of the provider whose keys are exhausted.
   * @returns {Object} Normalized error payload.
   */
  buildAllKeysExhaustedError(provider) {
    let retryAfterSeconds = 0;
    const keys = this.keyRegistry.pools[provider]?.keys;
    if (keys) {
      const now = Date.now();
      const activeCooldowns = keys
        .map((k) => k.cooldownUntil)
        .filter((t) => t > now);

      if (activeCooldowns.length > 0) {
        const earliestCooldownUntil = Math.min(...activeCooldowns);
        retryAfterSeconds = Math.max(0, Math.ceil((earliestCooldownUntil - now) / 1000));
      }
    }

    return {
      error: {
        code: 'all_keys_exhausted',
        message:
          `All keys for provider '${provider}' are currently in cooldown. `
          + `Retry after ${retryAfterSeconds} seconds.`,
        retryAfterSeconds,
        provider,
        httpStatus: 503,
      },
    };
  }
}

export default UnifiedOrchestrator;
