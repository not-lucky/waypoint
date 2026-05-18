import { applyRequestOverrides } from './requestOverrides.js';
import { runOrchestrationLoop } from './orchestrationEngine.js';
import { logDebug } from '../utils/loggerHelpers.js';

// Central registry of all active request AbortControllers.
// Used during graceful shutdown (in index.js) to cancel all in-flight requests.
export const activeControllers = new Set();

/**
 * WHAT: The central entry point for request routing and execution.
 * WHY: Orchestrates the request lifecycle: overrides headers, handles client aborts,
 * invokes fallback and retry engines, and tracks active abort controllers.
 */
export class UnifiedOrchestrator {
  constructor(keyRegistry, providerFactory, config = {}, logger = null) {
    this.keyRegistry = keyRegistry;
    this.providerFactory = providerFactory;
    this.config = config;
    this.logger = logger;
  }

  async executeCompletion(unifiedReq, rawReq, requestLog) {
    // Clone requests to avoid mutations bubbling back to controllers
    const req = { isFallback: false, ...unifiedReq };

    // Apply header-based overrides (temperature, thinking levels)
    applyRequestOverrides(req, rawReq);

    // Fetch the global retry limit from gateway configuration
    const retryLimit = this.config.gateway?.global_retry_limit ?? 3;
    const abortController = new AbortController();
    activeControllers.add(abortController);

    logDebug(this.logger, 'Request entry: executing completion', {
      model: req.model,
      provider: req.provider,
      stream: req.stream,
      thinkingEnabled: req.thinkingEnabled,
      thinkingBudget: req.thinkingBudget,
    });

    const target = rawReq?.res || rawReq;
    let cleanupCloseListener = null;

    // Handle client disconnections to instantly stop upstream queries
    if (target && typeof target.on === 'function') {
      const handleClose = () => {
        const isResponseObject = !!(rawReq && rawReq.res);
        if (isResponseObject && target.writableEnded) {
          return;
        }
        logDebug(this.logger, 'Request abort/cancel event detected via client disconnect');
        abortController.abort();
      };
      target.on('close', handleClose);
      cleanupCloseListener = () => {
        if (typeof target.off === 'function') {
          target.off('close', handleClose);
        }
      };
    }

    let isStreamingResponse = false;

    try {
      // Invoke the decomposed outer fallback loop orchestration engine
      const result = await runOrchestrationLoop({
        req,
        unifiedReq,
        keyRegistry: this.keyRegistry,
        providerFactory: this.providerFactory,
        config: this.config,
        logger: this.logger,
        abortController,
        requestLog,
        retryLimit,
        onStreamResponse: () => {
          isStreamingResponse = true;
        },
      });

      // If returning a stream, wrap it to release AbortController registry on complete/abort
      if (isStreamingResponse && result && typeof result[Symbol.asyncIterator] === 'function') {
        const wrappedResult = async function* wrappedResult() {
          try {
            for await (const chunk of result) {
              yield chunk;
            }
          } finally {
            if (cleanupCloseListener) {
              cleanupCloseListener();
            }
            activeControllers.delete(abortController);
          }
        };
        return wrappedResult();
      }

      return result;
    } finally {
      // For standard unary (non-streaming) completions, clean up the controller immediately
      if (!isStreamingResponse) {
        if (cleanupCloseListener) {
          cleanupCloseListener();
        }
        activeControllers.delete(abortController);
      }
    }
  }
}
