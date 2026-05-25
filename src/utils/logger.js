import fs from 'node:fs';
import path from 'node:path';
import {
  configure, configureSync, getConsoleSink, getLogger, reset,
} from '@logtape/logtape';
import { getFileSink } from '@logtape/file';

/**
 * Early-boot logger initialization using synchronous configuration.
 * Rationale: During system startup, application configuration (e.g., from YAML) may fail.
 * We must guarantee a baseline logging mechanism is active before these async operations begin,
 * ensuring any startup faults or configuration parsing errors are explicitly recorded
 * rather than swallowed silently.
 * Side Effect: Mutates the global LogTape configuration synchronously.
 */
try {
  configureSync({
    sinks: {
      console: getConsoleSink({
        formatter: (record) => `[${record.level.toUpperCase()}] ${record.message}\n`,
      }),
    },
    loggers: [
      {
        category: ['waypoint'],
        lowestLevel: 'info',
        sinks: ['console'],
      },
      {
        category: ['logtape', 'meta'],
        lowestLevel: 'warning',
        sinks: ['console'],
      },
    ],
  });
} catch (err) {
  // Edge Case: If this module is evaluated multiple times or LogTape is already configured
  // in a testing environment, configureSync throws. We silently swallow this error because
  // re-configuration is harmless as long as baseline logging is active.
}

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
const customJsonFormatter = (record) => {
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
const customTextFormatter = (record) => {
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
  return `[${level}] ${timestamp} ${category}: ${message}${metaStr}\n`;
};

/**
 * Re-configures the logging subsystem using fully resolved application state.
 * Architectural Intent: Logging requires configuration (levels, file paths, formats) that is
 * unknown until the CLI/YAML config is parsed. We delay this binding to prevent dropping
 * early logs, while ultimately re-routing sinks once definitive settings are available.
 * Side Effect: Overwrites the early-boot sinks. If `reset: true` is executed, it purges
 * existing LogTape configuration.
 *
 * @param {Object} config - The fully validated application configuration.
 */
export async function configureLogging(config) {
  const loggingConfig = config?.logging || {};
  const enableConsole = loggingConfig.enable_console !== false;
  let enableFile = !!loggingConfig.enable_file;
  let filePath = loggingConfig.file_path || '';
  const format = loggingConfig.format || 'json';
  const level = loggingConfig.level || 'info';

  if (process.env.VITEST) {
    if (filePath === './logs/Waypoint.log' || filePath === 'logs/Waypoint.log' || filePath.endsWith('/logs/Waypoint.log') || filePath.endsWith('\\logs/Waypoint.log')) {
      enableFile = false;
    }
  }

  const sinks = {};
  const activeSinks = [];

  const formatter = format === 'json' ? customJsonFormatter : customTextFormatter;

  if (enableConsole) {
    sinks.console = getConsoleSink({ formatter });
    activeSinks.push('console');
  }

  if (enableFile && filePath) {
    const absolutePath = path.resolve(filePath);
    const directory = path.dirname(absolutePath);
    // Edge case: Users frequently provide arbitrary file paths for logs; failing to create the
    // parent directory causes fatal startup crashes. Explicitly guarantee the directory tree
    // exists before attempting to write.
    fs.mkdirSync(directory, { recursive: true });

    sinks.file = getFileSink(absolutePath, { formatter });
    activeSinks.push('file');
  }

  // Intent: The `reset: true` flag ensures we cleanly swap the global singleton from our
  // early-boot configuration to the runtime configuration without leaking duplicate sink
  // registrations.
  await configure({
    sinks,
    loggers: [
      {
        category: ['waypoint'],
        lowestLevel: level,
        sinks: activeSinks,
      },
      {
        category: ['logtape'],
        lowestLevel: 'warning',
        sinks: activeSinks,
      },
    ],
    reset: true,
  });
}

/**
 * Factory for instantiating subsystem-specific child loggers.
 * Rationale: Centralizing logger creation ensures all application modules inherit the same
 * base category ('waypoint'). This enforces namespace consistency, which is critical for
 * granular log filtering and routing in production.
 *
 * @param {string} category - The specific subsystem category (e.g., 'http', 'auth').
 * @returns {Object} LogTape logger instance bound to the namespace.
 */
export const getAppLogger = (category) => getLogger(['waypoint', category]);

/**
 * Graceful termination hook for the logging pipeline.
 * Rationale: File sinks and remote log aggregators often buffer output asynchronously for
 * performance. During a SIGTERM or unhandled exception, failing to flush these buffers
 * results in dropped logs, destroying post-mortem observability.
 * Side Effect: Triggers an awaited reset across all active LogTape sinks.
 */
export async function flushLogs() {
  await reset();
}
