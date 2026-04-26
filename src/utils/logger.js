import fs from 'node:fs';
import path from 'node:path';
import {
  configure, configureSync, getConsoleSink, getLogger, reset,
} from '@logtape/logtape';
import { getFileSink } from '@logtape/file';

/**
 * Initializes early-boot default configuration.
 * Because reading config may fail, we want some base logging to capture why.
 * This ensures that logs are visible immediately upon startup before full configuration resolves.
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
  // If already configured, ignore.
}

/**
 * Safely parses and stringifies logged payloads to prevent format-breaking output.
 */
const formatMessage = (msg) => {
  if (Array.isArray(msg)) {
    return msg.map((m) => {
      if (m instanceof Error) return m.message;
      if (typeof m === 'object' && m !== null) return JSON.stringify(m);
      return String(m);
    }).join(' ');
  }
  return String(msg);
};

/**
 * Formatter for structured JSON logs.
 * Emits single-line JSON representations of events for robust ingestion by log aggregators
 * like ELK or Splunk, preserving the original schema without whitespace fragmentation.
 */
const customJsonFormatter = (record) => {
  const logObj = {
    level: record.level,
    timestamp: new Date(record.timestamp).toISOString(),
    message: formatMessage(record.message),
    category: record.category.join(':'),
    ...(record.properties || {}),
  };
  // Handle Error objects in properties or messages robustly
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
 * Human-readable string formatter designed for raw console or tail-f debugging.
 */
const customTextFormatter = (record) => {
  const timestamp = new Date(record.timestamp).toISOString();
  const category = record.category.join(':');
  const level = record.level.toUpperCase();
  const message = formatMessage(record.message);
  let metaStr = '';
  if (record.properties && Object.keys(record.properties).length > 0) {
    const pairs = [];
    Object.entries(record.properties).forEach(([key, val]) => {
      let valStr;
      if (val instanceof Error) {
        valStr = `[Error: ${val.message}]`;
      } else if (val && typeof val === 'object') {
        try {
          valStr = JSON.stringify(val);
        } catch (err) {
          valStr = `[Unserializable Object: ${err.message}]`;
        }
      } else {
        valStr = String(val);
      }
      if (valStr.includes(' ') || valStr.includes('"') || valStr.includes('\n') || valStr.includes('\r') || valStr.includes('\t')) {
        valStr = `"${valStr.replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
      }
      pairs.push(`${key}=${valStr}`);
    });
    if (pairs.length > 0) {
      metaStr = ` ${pairs.join(' ')}`;
    }
  }
  return `[${level}] ${timestamp} ${category}: ${message}${metaStr}\n`;
};

/**
 * Applies the validated logger configuration over the default runtime.
 * We lazily execute this function so that the application can properly bootstrap
 * its initial configuration values from process args and yaml definition before
 * permanently mutating the logging sinks.
 *
 * @param {Object} config - The application configuration.
 */
export async function configureLogging(config) {
  const loggingConfig = config?.logging || {};
  const enableConsole = loggingConfig.enable_console !== false;
  const enableFile = !!loggingConfig.enable_file;
  const filePath = loggingConfig.file_path || '';
  const format = loggingConfig.format || 'json';
  const level = loggingConfig.level || 'info';

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
    // Explicitly guarantee the directory tree exists before attempting to write.
    fs.mkdirSync(directory, { recursive: true });

    sinks.file = getFileSink(absolutePath, { formatter });
    activeSinks.push('file');
  }

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
 * Returns a configured child logger bound to a specific subsystem category.
 *
 * @param {string} category - The logger category.
 * @returns {Object} LogTape logger instance.
 */
export function getAppLogger(category) {
  return getLogger(['waypoint', category]);
}

/**
 * Forces all buffered output out of internal buffers before system exit.
 */
export async function flushLogs() {
  await reset();
}
