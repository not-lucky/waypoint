/**
 * @fileoverview Unified Orchestrator class.
 * Acts as the entrypoint for routing and executing request completions.
 * Manages request overrides, client disconnects, and fallback/retry engine.
 * @module services/UnifiedOrchestrator
 */

import { runOrchestrationLoop } from './orchestrationEngine.js';
import { getAppLogger } from '../infrastructure/logging/logger.js';
import { teardownRegistry } from '../infrastructure/lifecycle/teardownRegistry.js';

/**
 * Module-level logger for orchestrator-level events (entry, fallback, abort).
 * @type {Object}
 */
const logger = getAppLogger('orchestrator');

/**
 * Central registry of all active request AbortControllers.
 *
 * Every call to `executeCompletion` adds the request's AbortController to
 * this Set so graceful shutdown can abort all in-flight work without
 * leaking upstream sockets. Controllers are removed either in the
 * request's `finally` block (non-streaming) or in the wrapped stream's
 * `finally` (streaming). The Set is intentionally module-scoped (not a
 * class field) so the teardown hook below can reach it without holding a
 * reference to a particular orchestrator instance.
 *
 * Used during graceful shutdown to cancel all in-flight requests.
 * @type {Set<AbortController>}
 */
export const activeControllers = new Set();

/**
 * Teardown hook that aborts every active request AbortController.
 *
 * Registered with the global `teardownRegistry`, so it runs as part of the
 * graceful shutdown sequence initiated by `registerLifecycle` when the
 * process receives SIGINT/SIGTERM. Errors during individual `abort()`
 * calls are logged and swallowed — the goal is to clear the Set, not to
 * recover.
 *
 * @param {Object} [logger] - Optional logger instance for debug output.
 * @returns {void}
 */
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
 *
 * The orchestrator is intentionally stateless across requests — every call to
 * `executeCompletion` creates its own AbortController, registers its own
 * close listener, and tears everything down in a `finally` block. This keeps
 * the class cheap to instantiate and makes it safe to share one instance
 * across many concurrent requests.
 */
export class UnifiedOrchestrator {
  /**
   * Creates an instance of UnifiedOrchestrator.
   *
   * @param {Object} keyRegistry - Stateful API key registry instance.
   * @param {Object} providerFactory - Factory for creating provider adapter instances.
   * @param {Object} [config={}] - Application gateway configuration.
   */
  constructor(keyRegistry, providerFactory, config = {}) {
    this.keyRegistry = keyRegistry;
    this.providerFactory = providerFactory;
    this.config = config;
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
    if (rawReq?.isDryRun) {
      req.isDryRun = true;
    }

    // Fetch the global retry limit from gateway configuration
    const retryLimit = this.config.gateway?.globalRetryLimit ?? 3;
    const abortController = new AbortController();
    activeControllers.add(abortController);

    logger.debug('Request entry: executing completion', {
      model: req.model,
      provider: req.provider,
      stream: req.stream,
      reasoningSupported: req.reasoningSupported,
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
        logger.debug('Request abort/cancel event detected via client disconnect');
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
