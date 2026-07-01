import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  configure, configureSync, getConsoleSink, getLogger, reset,
} from '@logtape/logtape';
import { getFileSink } from '@logtape/file';
import { customJsonFormatter, customTextFormatter, formatMessage } from './logFormatters.js';

const sessionTimestamp = new Date().toISOString().replace( /[:.]/g, '-' );

/**
 * Default retention cap for Waypoint session log files.
 * Applied by configureLogging() at startup: when the log directory exceeds
 * this count, the oldest matching session files are pruned before the new
 * sink is opened. Keeps disk usage bounded across process restarts.
 */
export const DEFAULT_MAX_RETAINED_LOG_FILES = 1000;

/**
 * Escapes a string for safe use inside a RegExp.
 *
 * @private
 * @param {string} value - String to escape.
 * @returns {string} The escaped string.
 */
const escapeForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Prunes oldest Waypoint session log files when the directory exceeds
 * `maxRetained`. Only files matching `${baseName}_<timestamp>${ext}` are
 * considered for deletion; any other entries (operator notes, manual
 * uploads, unrelated `*.log` files) are preserved.
 *
 * Filenames are sorted lexically, which matches the ISO-derived timestamp
 * ordering used by `configureLogging()` so the oldest entries are removed
 * first. Falls back to mtime when two files share a timestamp prefix.
 *
 * @param {string} basePath - Absolute path to the log directory.
 * @param {string} baseName - Log base name (e.g. "waypoint").
 * @param {string} ext - File extension, including the leading dot (e.g. ".log").
 * @param {number} maxRetained - Maximum files to keep. Values <= 0 disable pruning.
 * @returns {Promise<number>} Number of files removed.
 */
export const pruneLogFiles = async (basePath, baseName, ext, maxRetained) => {
  if (!maxRetained || maxRetained <= 0) return 0;
  let entries;
  try {
    entries = await fsp.readdir(basePath);
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    return 0;
  }
  const pattern = new RegExp(`^${escapeForRegex(baseName)}_[^_]+${escapeForRegex(ext)}$`);
  const matched = [];
  for (const name of entries) {
    if (!pattern.test(name)) continue;
    try {
      const stat = await fsp.stat(path.join(basePath, name));
      if (stat.isFile()) matched.push({ name, mtime: stat.mtimeMs });
    } catch {
      // Race with concurrent cleanup or operator removal; skip.
    }
  }
  if (matched.length <= maxRetained) return 0;
  matched.sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return a.mtime - b.mtime;
  });
  const toRemove = matched.slice(0, matched.length - maxRetained);
  let removed = 0;
  for (const entry of toRemove) {
    try {
      await fsp.rm(path.join(basePath, entry.name));
      removed += 1;
    } catch {
      // Best-effort; skip files that cannot be removed.
    }
  }
  return removed;
};

/**
 * Early-boot logger initialization using synchronous configuration.
 * Rationale: During system startup, application configuration (e.g., from YAML) may fail.
 * We must guarantee a baseline logging mechanism is active before these async operations begin,
 * ensuring any startup faults or configuration parsing errors are explicitly recorded
 * rather than swallowed silently.
 * Side Effect: Mutates the global LogTape configuration synchronously.
 */
try {
  configureSync( {
    sinks: {
      console: getConsoleSink( {
        formatter: ( record ) => `[${ record.level.toUpperCase() }] ${ record.message }\n`,
      } ),
    },
    loggers: [
      {
        category: [ 'waypoint' ],
        lowestLevel: 'info',
        sinks: [ 'console' ],
      },
      {
        category: [ 'logtape', 'meta' ],
        lowestLevel: 'warning',
        sinks: [ 'console' ],
      },
    ],
  } );
} catch ( _err ) {
  // Edge Case: If this module is evaluated multiple times or LogTape is already configured
  // in a testing environment, configureSync throws. We silently swallow this error because
  // re-configuration is harmless as long as baseline logging is active.
}

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
export const configureLogging = async ( config, testConfig = {} ) => {
  const loggingConfig = config?.logging || {};
  const enableConsole = loggingConfig.enableConsole !== false;
  let enableFile = !!loggingConfig.enableFile;
  const originalFilePath = testConfig.filePath || loggingConfig.filePath || '';
  let filePath = originalFilePath;
  const format = loggingConfig.format || 'json';
  const level = loggingConfig.level || 'info';

  if ( testConfig.disableFile ) {
    enableFile = false;
  }

  if ( filePath && !testConfig.skipTimestamp ) {
    const parsedPath = path.parse( filePath );
    filePath = path.join( parsedPath.dir, `${ parsedPath.name }_${ sessionTimestamp }${ parsedPath.ext }` );
  }

  const sinks = {};
  const activeSinks = [];

  const formatter = format === 'json' ? customJsonFormatter : customTextFormatter;

  if ( enableConsole ) {
    sinks.console = getConsoleSink( { formatter } );
    activeSinks.push( 'console' );
  }

  if ( enableFile && filePath ) {
    const absolutePath = path.resolve( filePath );
    const directory = path.dirname( absolutePath );
    // Edge case: Users frequently provide arbitrary file paths for logs; failing to create the
    // parent directory causes fatal startup crashes. Explicitly guarantee the directory tree
    // exists before attempting to write.
    fs.mkdirSync( directory, { recursive: true } );

    // Apply retention before opening the new sink so the cap includes the
    // session file about to be created. The original (pre-timestamp) base
    // name and extension are reused so the regex matcher lines up exactly
    // with the filenames actually produced by previous sessions.
    const parsedOriginal = path.parse( originalFilePath );
    const maxRetainedLogFiles = typeof loggingConfig.maxRetainedLogFiles === 'number'
      ? loggingConfig.maxRetainedLogFiles
      : DEFAULT_MAX_RETAINED_LOG_FILES;
    await pruneLogFiles( directory, parsedOriginal.name, parsedOriginal.ext, maxRetainedLogFiles );

    sinks.file = getFileSink( absolutePath, { formatter } );
    activeSinks.push( 'file' );
  }

  // Intent: The `reset: true` flag ensures we cleanly swap the global singleton from our
  // early-boot configuration to the runtime configuration without leaking duplicate sink
  // registrations.
  await configure( {
    sinks,
    loggers: [
      {
        category: [ 'waypoint' ],
        lowestLevel: level,
        sinks: activeSinks,
      },
      {
        category: [ 'logtape' ],
        lowestLevel: 'warning',
        sinks: activeSinks,
      },
    ],
    reset: true,
  } );
};

/**
 * Factory for instantiating subsystem-specific child loggers.
 * Rationale: Centralizing logger creation ensures all application modules inherit the same
 * base category ('waypoint'). This enforces namespace consistency, which is critical for
 * granular log filtering and routing in production.
 *
 * @param {string} category - The specific subsystem category (e.g., 'http', 'auth').
 * @returns {Object} LogTape logger instance bound to the namespace.
 */
export const getAppLogger = ( category ) => getLogger( [ 'waypoint', category ] );

/**
 * Graceful termination hook for the logging pipeline.
 * Rationale: File sinks and remote log aggregators often buffer output asynchronously for
 * performance. During a SIGTERM or unhandled exception, failing to flush these buffers
 * results in dropped logs, destroying post-mortem observability.
 * Side Effect: Triggers an awaited reset across all active LogTape sinks.
 */
export const flushLogs = async () => {
  await reset();
};
