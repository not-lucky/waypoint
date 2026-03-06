/* eslint-disable no-restricted-syntax, no-constant-condition, no-await-in-loop, no-continue */

export class UnifiedOrchestrator {
  constructor(keyRegistry, providerFactory, config = {}) {
    this.keyRegistry = keyRegistry;
    this.providerFactory = providerFactory;
    this.config = config;
  }

  async executeCompletion(unifiedReq, rawReq) {
    let req = { ...unifiedReq };

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
        let resolvedProvider = null;
        let resolvedModelConfig = null;

        if (req.model.includes('/')) {
          const [providerPart, ...rest] = req.model.split('/');
          const modelPart = rest.join('/').trim();
          const cleanProvider = providerPart.trim();

          const providerConf = this.config.providers?.[cleanProvider];
          if (providerConf) {
            resolvedProvider = cleanProvider;
            const models = providerConf.models || [];
            resolvedModelConfig = models.find(
              (m) => m.id === modelPart || m.aliases?.includes(modelPart),
            ) || models.find((m) => m.actual_model_id === modelPart)
              || { id: modelPart, actual_model_id: modelPart };
          }
        }

        // If we couldn't resolve it via provider/model-id format, search all providers
        if (!resolvedProvider || !resolvedModelConfig) {
          const currentModel = req.model;
          for (const [pName, pConf] of Object.entries(this.config.providers || {})) {
            const models = pConf.models || [];
            const match = models.find(
              (m) => m.id === currentModel || m.aliases?.includes(currentModel),
            );
            if (match) {
              resolvedProvider = pName;
              resolvedModelConfig = match;
              break;
            }
          }
        }

        if (resolvedProvider && resolvedModelConfig) {
          req.provider = resolvedProvider;
          req.actualModelId = resolvedModelConfig.actual_model_id || resolvedModelConfig.id;

          if (resolvedModelConfig.fallback_model && !req.fallbackModel) {
            req.fallbackModel = resolvedModelConfig.fallback_model;
          }

          if (resolvedModelConfig.thinking_supported) {
            req.thinking_supported = true;
            if (
              req.thinkingBudget === undefined
              && resolvedModelConfig.default_thinking_budget !== undefined
            ) {
              req.thinkingBudget = resolvedModelConfig.default_thinking_budget;
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
          // No active keys available in the registry for this provider
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

      // Check if fallback is configured and this isn't already a fallback request
      if (req.fallbackModel && !req.isFallback) {
        const [fallbackProvider, ...rest] = req.fallbackModel.split('/');
        const fallbackModelId = rest.join('/');

        req = {
          ...req,
          provider: fallbackProvider,
          actualModelId: fallbackModelId,
          model: req.fallbackModel,
          isFallback: true,
        };
        continue;
      }

      // On loop exhaustion: return 503 NormalizedError {code:'all_keys_exhausted'}
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
          message: `All keys for provider '${provider}' are currently in cooldown. Retry after ${retryAfterSeconds} seconds.`,
          retryAfterSeconds,
          provider,
          httpStatus: 503,
        },
      };
    }
  }
}

export default UnifiedOrchestrator;
