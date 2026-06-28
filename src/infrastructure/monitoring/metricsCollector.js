const DEFAULT_HISTOGRAM_BUCKETS = [
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
];

function normalizeLabels(labels = {}) {
  return Object.fromEntries(
    Object.entries(labels)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, String(value)]),
  );
}

function serializeLabels(normalizedLabels = {}) {
  return JSON.stringify(normalizedLabels);
}

function escapeLabelValue(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n');
}

function formatLabels(labels = {}) {
  const entries = Object.entries(normalizeLabels(labels));
  if (entries.length === 0) return '';

  const body = entries
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(',');

  return `{${body}}`;
}

function getOrCreateMetric(store, name, factory) {
  if (!store[name]) {
    store[name] = factory();
  }

  return store[name];
}

function getCounterOrGaugeEntry(metric, labels) {
  const normalizedLabels = normalizeLabels(labels);
  const key = serializeLabels(normalizedLabels);
  const existing = metric.values.get(key);

  if (existing) {
    return existing;
  }

  const created = { labels: normalizedLabels, value: 0 };
  metric.values.set(key, created);
  return created;
}

function getHistogramEntry(metric, labels) {
  const normalizedLabels = normalizeLabels(labels);
  const key = serializeLabels(normalizedLabels);
  const existing = metric.values.get(key);

  if (existing) {
    return existing;
  }

  const created = {
    labels: normalizedLabels,
    buckets: metric.buckets.map((bucket) => ({ le: bucket, value: 0 })),
    count: 0,
    sum: 0,
  };
  metric.values.set(key, created);
  return created;
}

function appendMetricHeader(lines, name, type) {
  lines.push(`# TYPE ${name} ${type}`);
}

export class MetricsCollector {
  constructor() {
    this.counters = {};
    this.gauges = {};
    this.histograms = {};
  }

  incrementCounter(name, labels = {}, value = 1) {
    const metric = getOrCreateMetric(this.counters, name, () => ({
      type: 'counter',
      values: new Map(),
    }));
    const entry = getCounterOrGaugeEntry(metric, labels);
    entry.value += value;
  }

  setGauge(name, value, labels = {}) {
    const metric = getOrCreateMetric(this.gauges, name, () => ({
      type: 'gauge',
      values: new Map(),
    }));
    const entry = getCounterOrGaugeEntry(metric, labels);
    entry.value = value;
  }

  observeHistogram(name, value, labels = {}, buckets = DEFAULT_HISTOGRAM_BUCKETS) {
    const metric = getOrCreateMetric(this.histograms, name, () => ({
      type: 'histogram',
      // `Array.prototype.toSorted` (Node ≥ 20) returns a new array without
      // mutating the caller's buckets. Avoids the `[...buckets].sort(...)`
      // copy-then-sort dance and is a single allocation.
      buckets: buckets.toSorted((left, right) => left - right),
      values: new Map(),
    }));
    const entry = getHistogramEntry(metric, labels);

    entry.count += 1;
    entry.sum += value;
    entry.buckets.forEach((bucket) => {
      if (value <= bucket.le) {
        bucket.value += 1;
      }
    });
  }

  toPrometheusText() {
    const lines = [];

    Object.entries(this.counters).forEach(([name, metric]) => {
      appendMetricHeader(lines, name, metric.type);
      metric.values.forEach((entry) => {
        lines.push(`${name}${formatLabels(entry.labels)} ${entry.value}`);
      });
    });

    Object.entries(this.gauges).forEach(([name, metric]) => {
      appendMetricHeader(lines, name, metric.type);
      metric.values.forEach((entry) => {
        lines.push(`${name}${formatLabels(entry.labels)} ${entry.value}`);
      });
    });

    Object.entries(this.histograms).forEach(([name, metric]) => {
      appendMetricHeader(lines, name, metric.type);
      metric.values.forEach((entry) => {
        entry.buckets.forEach((bucket) => {
          lines.push(
            `${name}_bucket${formatLabels({ ...entry.labels, le: bucket.le })} ${bucket.value}`,
          );
        });
        lines.push(`${name}_bucket${formatLabels({ ...entry.labels, le: '+Inf' })} ${entry.count}`);
        lines.push(`${name}_sum${formatLabels(entry.labels)} ${entry.sum}`);
        lines.push(`${name}_count${formatLabels(entry.labels)} ${entry.count}`);
      });
    });

    return `${lines.join('\n')}\n`;
  }

  toJSON() {
    return {
      counters: Object.fromEntries(
        Object.entries(this.counters).map(([name, metric]) => [
          name,
          Array.from(metric.values.values()).map((entry) => ({
            labels: entry.labels,
            value: entry.value,
          })),
        ]),
      ),
      gauges: Object.fromEntries(
        Object.entries(this.gauges).map(([name, metric]) => [
          name,
          Array.from(metric.values.values()).map((entry) => ({
            labels: entry.labels,
            value: entry.value,
          })),
        ]),
      ),
      histograms: Object.fromEntries(
        Object.entries(this.histograms).map(([name, metric]) => [
          name,
          Array.from(metric.values.values()).map((entry) => ({
            labels: entry.labels,
            buckets: entry.buckets.map((bucket) => ({ ...bucket })),
            count: entry.count,
            sum: entry.sum,
          })),
        ]),
      ),
    };
  }
}

export function syncKeyPoolMetrics(metricsCollector, keyRegistry) {
  const { providers } = keyRegistry.getHealthStats();

  Object.entries(providers).forEach(([provider, stats]) => {
    metricsCollector.setGauge('waypoint_key_pool_active', stats.activeKeys, { provider });
    metricsCollector.setGauge('waypoint_key_pool_cooling', stats.coolingKeys, { provider });
    metricsCollector.setGauge('waypoint_key_pool_exhausted', stats.exhaustedKeys, { provider });
  });
}
