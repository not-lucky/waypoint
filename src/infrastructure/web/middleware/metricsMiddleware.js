import { performance } from 'node:perf_hooks';

function parseProviderFromModel(model) {
  if (typeof model !== 'string' || model.length === 0) {
    return null;
  }

  const slashIndex = model.indexOf('/');
  if (slashIndex === -1) {
    return null;
  }

  return model.slice(0, slashIndex) || null;
}

function parseTrackedRequest(req) {
  const path = req.originalUrl || req.url || '';
  const isOpenAICompletion = req.method === 'POST' && /\/openai(?:\/v1)?\/chat\/completions$/.test(path);
  const isAnthropicCompletion = req.method === 'POST' && /\/anthropic(?:\/v1)?\/messages$/.test(path);

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
}

export function createMetricsMiddleware(metricsCollector) {
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
}
