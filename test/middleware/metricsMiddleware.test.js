import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { MetricsCollector } from '../../src/monitoring/metricsCollector.js';
import { createMetricsMiddleware } from '../../src/middleware/metricsMiddleware.js';

describe('createMetricsMiddleware', () => {
  it('tracks request count and latency for completion requests', () => {
    const collector = new MetricsCollector();
    const middleware = createMetricsMiddleware(collector);
    const next = vi.fn();
    const req = {
      method: 'POST',
      originalUrl: '/openai/chat/completions',
      body: {
        model: 'gemini/gemini-pro',
      },
    };
    const res = new EventEmitter();
    res.statusCode = 200;

    middleware(req, res, next);
    res.emit('finish');

    const snapshot = collector.toJSON();
    expect(next).toHaveBeenCalledOnce();
    expect(snapshot.counters.waypoint_requests_total).toEqual([{
      labels: {
        model: 'gemini/gemini-pro',
        provider: 'gemini',
        status_code: '200',
      },
      value: 1,
    }]);
    expect(snapshot.histograms.waypoint_request_duration_seconds[0].labels).toEqual({
      model: 'gemini/gemini-pro',
      provider: 'gemini',
    });
    expect(snapshot.histograms.waypoint_request_duration_seconds[0].count).toBe(1);
  });

  it('ignores non-completion routes', () => {
    const collector = new MetricsCollector();
    const middleware = createMetricsMiddleware(collector);
    const next = vi.fn();
    const req = {
      method: 'GET',
      originalUrl: '/health',
      body: {},
    };
    const res = new EventEmitter();
    res.statusCode = 200;

    middleware(req, res, next);
    res.emit('finish');

    expect(next).toHaveBeenCalledOnce();
    expect(collector.toJSON()).toEqual({
      counters: {},
      gauges: {},
      histograms: {},
    });
  });
});
