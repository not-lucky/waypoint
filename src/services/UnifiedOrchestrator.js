/**
 * @fileoverview Unified Orchestrator class.
 * Acts as the entrypoint for routing and executing request completions.
 * Manages request overrides, client disconnects, and fallback/retry engine.
 * @module services/UnifiedOrchestrator
 */

import { applyRequestOverrides } from './requestOverrides.js';
import { runOrchestrationLoop } from './orchestrationEngine.js';
import { logDebug } from '../utils/loggerHelpers.js';
import { teardownRegistry } from '../registry/TeardownRegistry.js';

/**
 * Central registry of all active request AbortControllers.
 * Used during graceful shutdown to cancel all in-flight requests.
 * @type {Set<AbortController>}
 */
export const activeControllers = new Set();

teardownRegistry.add((logger) => {
  if (logger && typeof logger.debug === 'function') {
    logger.debug(`Graceful shutdown: aborting ${activeControllers.size} active connections`);
  }
  activeControllers.forEach((ctrl) => {
    try {
      ctrl.abort();
    } catch (err) {
      if (logger && typeof logger.error === 'function') {
        logger.error('Error aborting active controller during teardown:', err);
      }
    }
  });
  activeControllers.clear();
});

/**
 * Orchestrates the request lifecycle: overrides headers, handles client aborts,
 * invokes fallback and retry engines, and tracks active abort controllers.
 */
export class UnifiedOrchestrator {
  /**
   * Creates an instance of UnifiedOrchestrator.
   *
   * @param {Object} keyRegistry - Stateful API key registry instance.
   * @param {Object} providerFactory - Factory for creating provider adapter instances.
   * @param {Object} [config={}] - Application gateway configuration.
   * @param {Object|null} [logger=null] - Optional logger instance.
   */
  constructor(keyRegistry, providerFactory, config = {}, logger = null) {
    this.keyRegistry = keyRegistry;
    this.providerFactory = providerFactory;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Main entrypoint to execute completion request.
   * Standardizes incoming request formatting, applies config/header overrides,
   * runs the fallback-retry engine, handles client disconnects, and manages stream iteration.
   *
   * @param {Object} unifiedReq - The unified/normalized request object.
   * @param {import('express').Request} rawReq - The raw Express request object.
   * @param {Object|null} requestLog - Telemetry / request logging context.
   * @returns {Promise<Object|AsyncGenerator>} Completion response or chunk generator.
   * @throws {Error} Relays adapter execution errors if retry limits are exceeded.
   */
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
