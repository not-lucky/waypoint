import fs from 'node:fs';
import path from 'node:path';
import { configure, configureSync, getConsoleSink, getLogger, reset } from '@logtape/logtape';
import { getFileSink } from '@logtape/file';

// Default configuration so that loggers are active even before custom config is loaded.
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

const formatMessage = (msg) => {
  if (Array.isArray(msg)) {
    return msg.map(m => (m instanceof Error ? m.message : (typeof m === 'object' ? JSON.stringify(m) : String(m)))).join(' ');
  }
  return String(msg);
};

const customJsonFormatter = (record) => {
  const logObj = {
    level: record.level,
    timestamp: new Date(record.timestamp).toISOString(),
    message: formatMessage(record.message),
    category: record.category.join(':'),
    ...(record.properties || {}),
  };
  // Handle Error objects in properties or messages
  for (const [key, val] of Object.entries(logObj)) {
    if (val instanceof Error) {
      logObj[key] = {
        message: val.message,
        stack: val.stack,
      };
    }
  }
  return JSON.stringify(logObj) + '\n';
};

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
 * Configures the LogTape logging system.
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
 * Returns a LogTape logger for the specified category.
 *
 * @param {string} category - The logger category.
 * @returns {Object} LogTape logger instance.
 */
export function getAppLogger(category) {
  return getLogger(['waypoint', category]);
}

/**
 * Flushes all pending logs and disposes of the sinks.
 */
export async function flushLogs() {
  await reset();
}
