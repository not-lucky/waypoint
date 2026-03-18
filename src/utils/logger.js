import fs from 'node:fs';
import path from 'node:path';

/**
 * Creates a configured structured logger instance.
 *
 * @param {Object} config - The loaded application configuration.
 * @returns {Object} Logger instance with info, warn, error, fatal, and flush methods.
 */
export default function createLogger(config) {
  const loggingConfig = config?.logging || {};
  // Default to true: console output is on unless explicitly disabled.
  // Using !== false (rather than !!val) so that omitted config still enables console.
  const enableConsole = loggingConfig.enable_console !== false;
  const enableFile = !!loggingConfig.enable_file;
  const filePath = loggingConfig.file_path || '';
  const format = loggingConfig.format || 'json';

  let fileStream = null;
  // Track in-flight file writes so flush() can wait for them to drain.
  let pendingWrites = 0;
  // Accumulated resolve callbacks from flush() callers, invoked once pendingWrites reaches 0.
  let flushResolvers = [];

  if (enableFile && filePath) {
    const absolutePath = path.resolve(filePath);
    const directory = path.dirname(absolutePath);
    fs.mkdirSync(directory, { recursive: true });
    fileStream = fs.createWriteStream(absolutePath, { flags: 'a', encoding: 'utf8' });
    fileStream.on('error', (err) => {
      console.error(`Failed to write to log file at ${absolutePath}:`, err);
    });
  }

  function log(level, msg, meta) {
    const timestamp = new Date().toISOString();
    let message = msg;
    let metaObj = meta;

    // Allow passing Error objects directly: extract message and inject stack into metadata.
    if (msg instanceof Error) {
      message = msg.message;
      metaObj = { stack: msg.stack, ...metaObj };
    } else if (typeof msg !== 'string') {
      // Coerce non-string, non-Error values (e.g. numbers, booleans) to string.
      message = String(msg);
    }

    let line = '';
    if (format === 'text') {
      let metaStr = '';
      if (metaObj && typeof metaObj === 'object') {
        const pairs = [];
        Object.entries(metaObj).forEach(([key, val]) => {
          let valStr;
          if (val && typeof val === 'object') {
            try {
              valStr = JSON.stringify(val);
            } catch (err) {
              valStr = `[Unserializable Object: ${err.message}]`;
            }
          } else {
            valStr = String(val);
          }
          // Quote values containing whitespace, embedded quotes, or newlines to keep
          // the key=value text format safely parseable.
          if (valStr.includes(' ') || valStr.includes('"') || valStr.includes('\n')) {
            valStr = `"${valStr.replace(/"/g, '\\"')}"`;
          }
          pairs.push(`${key}=${valStr}`);
        });
        if (pairs.length > 0) {
          metaStr = ` ${pairs.join(' ')}`;
        }
      }
      line = `[${level}] ${timestamp} ${message}${metaStr}`;
    } else {
      const logObj = {
        level,
        timestamp,
        message,
        // Spread metadata into the JSON object; silently ignore non-object
        // meta (e.g. a raw string passed as meta).
        ...(metaObj && typeof metaObj === 'object' ? metaObj : {}),
      };
      try {
        line = JSON.stringify(logObj);
      } catch (err) {
        try {
          line = JSON.stringify({
            level,
            timestamp,
            message,
            logging_error: `Failed to serialize log metadata: ${err.message}`,
          });
        } catch (fallbackErr) {
          line = `{"level":"${level}","timestamp":"${timestamp}","message":"${message} (Serialization Failed)"}`;
        }
      }
    }

    if (enableConsole) {
      if (level === 'INFO') {
        process.stdout.write(`${line}\n`);
      } else {
        process.stderr.write(`${line}\n`);
      }
    }

    if (fileStream) {
      pendingWrites += 1;
      fileStream.write(`${line}\n`, 'utf8', () => {
        pendingWrites -= 1;
        // When the last pending write completes, resolve all waiting flush() promises.
        // Swap the array first to prevent re-entrancy issues if a resolver triggers more writes.
        if (pendingWrites === 0) {
          const resolvers = flushResolvers;
          flushResolvers = [];
          resolvers.forEach((resolve) => resolve());
        }
      });
    }
  }

  return {
    info: (msg, meta) => log('INFO', msg, meta),
    warn: (msg, meta) => log('WARN', msg, meta),
    error: (msg, meta) => log('ERROR', msg, meta),
    fatal: (msg, meta) => log('FATAL', msg, meta),
    flush: () => {
      if (!fileStream || pendingWrites === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        flushResolvers.push(resolve);
      });
    },
    // Expose fileStream reference primarily for testing or cleanup if needed
    _fileStream: fileStream,
  };
}
