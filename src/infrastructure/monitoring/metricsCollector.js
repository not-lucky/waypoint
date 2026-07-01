/**
 * @fileoverview Prometheus-format metrics collector.
 *
 * A small in-memory implementation of the three Prometheus metric types
 * (counter, gauge, histogram) plus a helper to serialize the collection
 * to the Prometheus text exposition format. Designed for the gateway's
 * `/metrics` endpoint; no time-series database is involved.
 *
 * @module infrastructure/monitoring/metricsCollector
 */

/**
 * Default histogram bucket layout (in seconds). Chosen to cover the
 * realistic p50–p99 latency spread of LLM providers (50ms–10s).
 *
 * @const {number[]}
 */
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

/**
 * Normalizes a labels object for stable identity.
 *
 * Drops undefined values, coerces all values to strings, and sorts the
 * keys alphabetically. The resulting object is suitable for use as a
 * cache key because two calls with semantically identical labels produce
 * the same string.
 *
 * @param {Object} [labels={}] - Raw labels object.
 * @returns {Object<string, string>} The normalized labels.
 */
function normalizeLabels(labels = {}) {
  return Object.fromEntries(
    Object.entries(labels)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, String(value)]),
  );
}

/**
 * Serializes a normalized labels object to a stable string key.
 *
 * @param {Object} [normalizedLabels={}] - Pre-normalized labels.
 * @returns {string} The serialized key (JSON-encoded, keys sorted).
 */
function serializeLabels(normalizedLabels = {}) {
  return JSON.stringify(normalizedLabels);
}

/**
 * Escapes a Prometheus label value per the spec.
 *
 * The spec requires `\\`, `"`, and newline to be escaped. Other characters
 * pass through unchanged.
 *
 * @param {string} value - The raw label value.
 * @returns {string} The escaped label value.
 */
function escapeLabelValue(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n');
}

/**
 * Formats a labels object as the `{key="value",...}` segment of a
 * Prometheus line. Returns an empty string when no labels are present.
 *
 * @param {Object} [labels={}] - Raw labels object.
 * @returns {string} The formatted labels segment.
 */
function formatLabels(labels = {}) {
  const entries = Object.entries(normalizeLabels(labels));
  if (entries.length === 0) return '';

  const body = entries
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(',');

  return `{${body}}`;
}

/**
 * Lazy-creates a metric entry in the supplied store.
 *
 * @param {Object} store - The metric store (e.g. `this.counters`).
 * @param {string} name - Metric name.
 * @param {Function} factory - Factory creating the metric skeleton.
 * @returns {Object} The metric entry.
 */
function getOrCreateMetric(store, name, factory) {
  if (!store[name]) {
    store[name] = factory();
  }

  return store[name];
}

/**
 * Looks up (or creates) the per-label-set entry for a counter or gauge.
 *
 * @param {Object} metric - The metric skeleton.
 * @param {Object} labels - Raw labels for the observation.
 * @returns {{ labels: Object, value: number }} The entry.
 */
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

/**
 * Looks up (or creates) the per-label-set entry for a histogram.
 *
 * @param {Object} metric - The metric skeleton.
 * @param {Object} labels - Raw labels for the observation.
 * @returns {{ labels: Object, buckets: Array<{le: number, value: number}>, count: number, sum: number }}
 *   The entry.
 */
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

/**
 * Appends a `# TYPE` line to the supplied lines array.
 *
 * @param {string[]} lines - The lines array to mutate.
 * @param {string} name - Metric name.
 * @param {string} type - Prometheus metric type (`counter`/`gauge`/`histogram`).
 * @returns {void}
 */
function appendMetricHeader(lines, name, type) {
  lines.push(`# TYPE ${name} ${type}`);
}

/**
 * In-memory Prometheus-format metrics collector.
 *
 * Backed by plain objects (`counters`, `gauges`, `histograms`); each
 * metric is created on first use and reused on subsequent calls.
 * Per-label-set values are stored in a `Map` keyed by the serialized
 * labels so duplicates collapse into a single entry.
 */
export class MetricsCollector {
  /**
   * Creates an empty collector.
   */
  constructor() {
    /**
     * Registered counter metrics.
     * @type {Object<string, {type: string, values: Map<string, Object>>}
     */
    this.counters = {};

    /**
     * Registered gauge metrics.
     * @type {Object<string, {type: string, values: Map<string, Object>>}
     */
    this.gauges = {};

    /**
     * Registered histogram metrics.
     * @type {Object<string, {type: string, buckets: number[], values: Map<string, Object>>}
     */
    this.histograms = {};
  }

  /**
   * Increments a counter by `value` (default 1).
   *
   * Creates the counter lazily on first use. Negative values are
   * accepted by Prometheus client conventions but rejected by most
   * scrapers; we don't validate here.
   *
   * @param {string} name - Counter name.
   * @param {Object} [labels={}] - Label set for the observation.
   * @param {number} [value=1] - Increment amount.
   * @returns {void}
   */
  incrementCounter(name, labels = {}, value = 1) {
    const metric = getOrCreateMetric(this.counters, name, () => ({
      type: 'counter',
      values: new Map(),
    }));
    const entry = getCounterOrGaugeEntry(metric, labels);
    entry.value += value;
  }

  /**
   * Sets a gauge to the supplied value (overwrites any previous value).
   *
   * @param {string} name - Gauge name.
   * @param {number} value - New gauge value.
   * @param {Object} [labels={}] - Label set for the observation.
   * @returns {void}
   */
  setGauge(name, value, labels = {}) {
    const metric = getOrCreateMetric(this.gauges, name, () => ({
      type: 'gauge',
      values: new Map(),
    }));
    const entry = getCounterOrGaugeEntry(metric, labels);
    entry.value = value;
  }

  /**
   * Records a histogram observation.
   *
   * Each observation increments `count`, adds the value to `sum`, and
   * increments the bucket counter for every bucket whose `le` is greater
   * than or equal to the observed value. The supplied `buckets` array is
   * sorted (ascending) once at metric creation time using
   * `Array.prototype.toSorted` so callers may pass them in any order.
   *
   * @param {string} name - Histogram name.
   * @param {number} value - Observed value.
   * @param {Object} [labels={}] - Label set for the observation.
   * @param {number[]} [buckets=DEFAULT_HISTOGRAM_BUCKETS] - Custom bucket bounds.
   * @returns {void}
   */
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

  /**
   * Serializes the collector to Prometheus text exposition format.
   *
   * Each metric is preceded by a `# TYPE <name> <type>` line and
   * followed by per-label-set sample lines. Histograms additionally
   * emit `_bucket{le="..."}`, `_sum`, and `_count` series.
   *
   * @returns {string} The full Prometheus text body.
   */
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

  /**
   * Returns a JSON-friendly snapshot of the collector's state.
   *
   * Used by integration tests to assert metric updates without parsing
   * the Prometheus text format. Maps are converted to arrays of
   * `{ labels, value }` (or `{ labels, buckets, count, sum }` for
   * histograms) so the structure is JSON-native.
   *
   * @returns {{ counters: Object, gauges: Object, histograms: Object }}
   */
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

/**
 * Snapshots the key-pool health gauges into the supplied collector.
 *
 * Called from `/metrics` before serialization so each scrape always
 * reflects the freshest pool state. Emits three gauges per provider:
 * `waypoint_key_pool_active`, `waypoint_key_pool_cooling`, and
 * `waypoint_key_pool_exhausted`.
 *
 * @param {MetricsCollector} metricsCollector - The collector to update.
 * @param {import('../../domain/keys/keyRegistry.js').KeyRegistry} keyRegistry -
 *   The key registry whose per-provider health stats to publish.
 * @returns {void}
 */
export function syncKeyPoolMetrics(metricsCollector, keyRegistry) {
  const { providers } = keyRegistry.getHealthStats();

  Object.entries(providers).forEach(([provider, stats]) => {
    metricsCollector.setGauge('waypoint_key_pool_active', stats.activeKeys, { provider });
    metricsCollector.setGauge('waypoint_key_pool_cooling', stats.coolingKeys, { provider });
    metricsCollector.setGauge('waypoint_key_pool_exhausted', stats.exhaustedKeys, { provider });
  });
}
