import { styleText } from 'node:util';

/**
 * Per-level ANSI foreground color used by the text formatter when stdout is a
 * TTY. `styleText` (Node ≥ 21.3) is a no-op for non-TTY destinations, so the
 * map is safe to apply unconditionally; the values only render in a terminal.
 * @const {Record<string, string>}
 */
const LEVEL_COLORS = {
  debug: 'gray',
  info: 'cyan',
  warning: 'yellow',
  error: 'red',
  fatal: 'magenta',
};

/**
 * Returns the colored `[LEVEL]` tag for the text formatter when stdout is a
 * TTY; otherwise returns the plain string. `styleText` is wrapped here so the
 * formatter stays simple and so the no-TTY path is allocation-free.
 * @param {string} level
 * @returns {string}
 */
const colorizeLevelTag = (level) => {
  if (!process.stdout.isTTY) return level;
  const color = LEVEL_COLORS[level] || 'white';
  return styleText(color, level);
};

/**
 * Normalizes mixed-type log payloads into safe string representations.
 * Rationale: Logging pipelines often break when encountering cyclic objects or unhandled data
 * types within arrays. This function guarantees that arrays and primitive values are aggressively
 * coerced into scalar strings, mitigating the risk of downstream log aggregator parsing failures
 * or serialization crashes.
 *
 * @param {any} msg - The log payload to format.
 * @returns {string} Safe stringified payload.
 */
export const formatMessage = (msg) => {
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg)) {
    return msg.map((m) => {
      // Intent: Isolate native Error instances to extract their human-readable message
      // without noisy object brackets.
      if (m instanceof Error) return m.message;
      // Intent: Ensure objects are converted to strict JSON instead of "[object Object]"
      // to retain observability.
      if (typeof m === 'object' && m !== null) return JSON.stringify(m);
      return String(m);
    }).join(' ');
  }
  return String(msg);
};

/**
 * JSON log formatter for structured telemetry.
 * Rationale: In production environments, raw text logs lack queryable structure.
 * This enforces a strict schema for all events, allowing deterministic ingestion by
 * observability platforms (ELK, Datadog). It deliberately emits single-line JSON to prevent
 * multi-line log fragmentation during transport over standard streams (stdout).
 *
 * @param {Object} record - The LogTape log record.
 * @returns {string} Newline-terminated JSON string.
 */
export const customJsonFormatter = (record) => {
  const logObj = {
    level: record.level,
    timestamp: new Date(record.timestamp).toISOString(),
    message: formatMessage(record.message),
    category: record.category.join(':'),
    ...(record.properties || {}),
  };
  // Edge Case: Native Error objects do not serialize to JSON via JSON.stringify()
  // (properties are non-enumerable). We explicitly reconstruct Error shapes to ensure
  // stack traces and messages are durably exported.
  Object.entries(logObj).forEach(([key, val]) => {
    if (val instanceof Error) {
      logObj[key] = {
        message: val.message,
        stack: val.stack,
      };
    }
  });
  return `${JSON.stringify(logObj)}\n`;
};

/**
 * Escapes special characters in log values for safe formatting.
 * @param {string} val - Value to escape
 * @returns {string} Escaped value
 */
const escapeLogValue = (val) => {
  if (val.includes(' ') || val.includes('"') || val.includes('\n') || val.includes('\r') || val.includes('\t')) {
    return `"${val.replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
  }
  return val;
};

/**
 * Formats a single property value for log output.
 * @param {*} val - Value to format
 * @returns {string} Formatted value string
 */
const formatPropertyValue = (val) => {
  if (val instanceof Error) {
    return `[Error: ${val.message}]`;
  }
  if (val && typeof val === 'object') {
    try {
      return JSON.stringify(val);
    } catch (err) {
      return `[Unserializable Object: ${err.message}]`;
    }
  }
  return String(val);
};

/**
 * Text formatter optimized for local developer experience.
 * Architectural Intent: During development, human readability is prioritized over machine
 * parsability. This transforms structured records into dense, color-agnostic linear strings,
 * appending metadata as key-value pairs. It defensively handles nested objects and
 * un-serializable properties, ensuring the developer sees all context without the process
 * crashing.
 *
 * @param {Object} record - The LogTape log record.
 * @returns {string} Formatted log line.
 */
export const customTextFormatter = (record) => {
  const timestamp = new Date(record.timestamp).toISOString();
  const category = record.category.join(':');
  const level = record.level.toUpperCase();
  const message = formatMessage(record.message);

  const pairs = [];
  if (record.properties && Object.keys(record.properties).length > 0) {
    Object.entries(record.properties).forEach(([key, val]) => {
      const valStr = escapeLogValue(formatPropertyValue(val));
      pairs.push(`${key}=${valStr}`);
    });
  }

  const metaStr = pairs.length > 0 ? ` ${pairs.join(' ')}` : '';
  return `[${colorizeLevelTag(level)}] ${timestamp} ${category}: ${message}${metaStr}\n`;
};