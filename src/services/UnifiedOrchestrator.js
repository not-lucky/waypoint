/* eslint-disable no-restricted-syntax, no-constant-condition, no-await-in-loop, no-continue */

export class UnifiedOrchestrator {
  constructor(keyRegistry, providerFactory, config = {}) {
    this.keyRegistry = keyRegistry;
    this.providerFactory = providerFactory;
    this.config = config;
  }

  async executeCompletion(unifiedReq, rawReq) {
    let req = { ...unifiedReq };
    const retryLimit = this.config.gateway?.global_retry_limit ?? 3;

    // Create an abort signal and listen to the request close event
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

      let lastError = null;

      // Inner loop for key rotation/retries
      for (let attempt = 0; attempt < retryLimit; attempt += 1) {
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

        try {
          const response = await adapter.generateCompletion(req, apiKey, abortController.signal);
          this.keyRegistry.flagSuccess(provider, apiKey);
          return response;
        } catch (error) {
          lastError = error;
          const statusCode = error?.statusCode || error?.response?.status || 500;
          this.keyRegistry.flagFailure(provider, apiKey, statusCode);
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

      // If we got here, either fallback is not configured, or fallback also failed,
      // or we exhausted retries with no active keys available.
      if (lastError) {
        const normalized = adapter.normalizeError(lastError);
        return { error: normalized };
      }

      // No key was available and no adapter call was made
      return {
        error: {
          code: 'upstream_rate_limited',
          message: `All keys for provider '${provider}' are currently in cooldown.`,
          provider,
          httpStatus: 503,
        },
      };
    }
  }
}

export default UnifiedOrchestrator;
