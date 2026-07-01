/**
 * @fileoverview Request-level metrics middleware.
 *
 * Increments the per-request Prometheus counters and observes the request
 * duration histogram on `res.finish`. Only OpenAI-style
 * `/chat/completions` and Anthropic-style `/messages` paths are tracked;
 * every other route is a passthrough so health/metrics scrapes don't pollute
 * the counters.
 */

import { performance } from 'node:perf_hooks';

/**
 * Extracts the provider segment from a `"provider/model"` identifier.
 *
 * @param {string} model - Model identifier (e.g. `"openai/gpt-4o-mini"`).
 * @returns {string|null} Lowercase provider segment, or null when the
 *   identifier is not a string, is empty, or has no slash.
 */
const parseProviderFromModel = (model) => {
  if (typeof model !== 'string' || model.length === 0) {
    return null;
  }

  const slashIndex = model.indexOf('/');
  if (slashIndex === -1) {
    return null;
  }

  return model.slice(0, slashIndex) || null;
};

/**
 * Detects whether the current request is a tracked completion endpoint and,
 * if so, returns the labels to attach to the metric updates.
 *
 * Returns `null` for any other route so the middleware can short-circuit
 * without touching the collector.
 *
 * @param {import('express').Request} req - Express request.
 * @returns {{ provider: string, model: string } | null} Label set, or null.
 */
const parseTrackedRequest = (req) => {
  const path = req.originalUrl || req.url || '';
  const isOpenAICompletion = req.method === 'POST' && /\/(?:v1\/)?chat\/completions$/.test(path);
  const isAnthropicCompletion = req.method === 'POST' && /\/(?:v1\/)?messages$/.test(path);

  if (!isOpenAICompletion && !isAnthropicCompletion) {
    return null;
  }

  const model = typeof req.body?.model === 'string' && req.body.model.length > 0
    ? req.body.model
    : 'unknown';

  return {
    provider: parseProviderFromModel(model) || (isAnthropicCompletion ? 'anthropic' : 'openai'),
    model,
  };
};

/**
 * Builds the metrics middleware bound to the supplied collector.
 *
 * The middleware:
 * 1. Parses the request to decide whether it should be tracked.
 * 2. On response `finish`, increments `waypoint_requests_total` with
 *    `provider`, `model`, and `status_code` labels.
 * 3. Records the wall-clock duration in `waypoint_request_duration_seconds`
 *    histogram (also labelled by provider/model).
 *
 * @param {import('../../monitoring/metricsCollector.js').MetricsCollector} metricsCollector - The collector.
 * @returns {import('express').RequestHandler} Express middleware.
 */
export const createMetricsMiddleware = (metricsCollector) => {
  return (req, res, next) => {
    const labels = parseTrackedRequest(req);
    if (!labels) {
      return next();
    }

    const startTime = performance.now();
    res.on('finish', () => {
      const durationSeconds = (performance.now() - startTime) / 1000;
      metricsCollector.incrementCounter('waypoint_requests_total', {
        ...labels,
        status_code: String(res.statusCode),
      });
      metricsCollector.observeHistogram(
        'waypoint_request_duration_seconds',
        durationSeconds,
        labels,
      );
    });

    return next();
  };
};