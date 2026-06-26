import { describe, it, expect } from 'vitest';
import {
  MetricsCollector,
  syncKeyPoolMetrics,
} from '../../../src/infrastructure/monitoring/metricsCollector.js';
import { KeyRegistry } from '../../../src/domain/keys/keyRegistry.js';

describe('MetricsCollector', () => {
  it('tracks counters, gauges, and histograms in JSON snapshots', () => {
    const collector = new MetricsCollector();

    collector.incrementCounter('waypoint_requests_total', {
      provider: 'gemini',
      model: 'gemini/gemini-pro',
      status_code: '200',
    });
    collector.setGauge('waypoint_key_pool_active', 2, { provider: 'gemini' });
    collector.observeHistogram('waypoint_request_duration_seconds', 0.125, {
      provider: 'gemini',
      model: 'gemini/gemini-pro',
    });

    expect(collector.toJSON()).toEqual({
      counters: {
        waypoint_requests_total: [{
          labels: {
            model: 'gemini/gemini-pro',
            provider: 'gemini',
            status_code: '200',
          },
          value: 1,
        }],
      },
      gauges: {
        waypoint_key_pool_active: [{
          labels: {
            provider: 'gemini',
          },
          value: 2,
        }],
      },
      histograms: {
        waypoint_request_duration_seconds: [{
          labels: {
            model: 'gemini/gemini-pro',
            provider: 'gemini',
          },
          buckets: expect.any(Array),
          count: 1,
          sum: 0.125,
        }],
      },
    });
  });

  it('renders Prometheus text for counters, gauges, and histograms', () => {
    const collector = new MetricsCollector();

    collector.incrementCounter('waypoint_requests_total', {
      provider: 'openai',
      model: 'openai/gpt-4o',
      status_code: '200',
    });
    collector.setGauge('waypoint_key_pool_cooling', 1, { provider: 'openai' });
    collector.observeHistogram('waypoint_request_duration_seconds', 0.25, {
      provider: 'openai',
      model: 'openai/gpt-4o',
    });

    const text = collector.toPrometheusText();

    expect(text).toContain('# TYPE waypoint_requests_total counter');
    expect(text).toContain('waypoint_requests_total{model="openai/gpt-4o",provider="openai",status_code="200"} 1');
    expect(text).toContain('# TYPE waypoint_key_pool_cooling gauge');
    expect(text).toContain('waypoint_key_pool_cooling{provider="openai"} 1');
    expect(text).toContain('# TYPE waypoint_request_duration_seconds histogram');
    expect(text).toContain('waypoint_request_duration_seconds_bucket{le="0.25",model="openai/gpt-4o",provider="openai"} 1');
    expect(text).toContain('waypoint_request_duration_seconds_count{model="openai/gpt-4o",provider="openai"} 1');
    expect(text).toContain('waypoint_request_duration_seconds_sum{model="openai/gpt-4o",provider="openai"} 0.25');
  });

  it('syncs key pool gauges from the key registry', () => {
    const collector = new MetricsCollector();
    const registry = new KeyRegistry({
      providers: {
        gemini: { keys: ['key-1', 'key-2'] },
      },
    });

    registry.flagFailure('gemini', 'key-1', {
      statusCode: 429,
    });

    syncKeyPoolMetrics(collector, registry);

    expect(collector.toJSON().gauges).toEqual({
      waypoint_key_pool_active: [{
        labels: { provider: 'gemini' },
        value: 1,
      }],
      waypoint_key_pool_cooling: [{
        labels: { provider: 'gemini' },
        value: 1,
      }],
      waypoint_key_pool_exhausted: [{
        labels: { provider: 'gemini' },
        value: 0,
      }],
    });
  });
});
