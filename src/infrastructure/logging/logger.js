import fs from 'node:fs'
import path from 'node:path'
import {
  configure, configureSync, getConsoleSink, getLogger, reset,
} from '@logtape/logtape'
import { getFileSink } from '@logtape/file'
import { customJsonFormatter, customTextFormatter, formatMessage } from './logFormatters.js'

export { formatMessage }

const sessionTimestamp = new Date().toISOString().replace( /[:.]/g, '-' )

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
  } )
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
  const loggingConfig = config?.logging || {}
  const enableConsole = loggingConfig.enableConsole !== false
  let enableFile = !!loggingConfig.enableFile
  let filePath = testConfig.filePath || loggingConfig.filePath || ''
  const format = loggingConfig.format || 'json'
  const level = loggingConfig.level || 'info'

  if ( testConfig.disableFile ) {
    enableFile = false
  }

  if ( filePath && !testConfig.skipTimestamp ) {
    const parsedPath = path.parse( filePath )
    filePath = path.join( parsedPath.dir, `${ parsedPath.name }_${ sessionTimestamp }${ parsedPath.ext }` )
  }

  const sinks = {}
  const activeSinks = []

  const formatter = format === 'json' ? customJsonFormatter : customTextFormatter

  if ( enableConsole ) {
    sinks.console = getConsoleSink( { formatter } )
    activeSinks.push( 'console' )
  }

  if ( enableFile && filePath ) {
    const absolutePath = path.resolve( filePath )
    const directory = path.dirname( absolutePath )
    // Edge case: Users frequently provide arbitrary file paths for logs; failing to create the
    // parent directory causes fatal startup crashes. Explicitly guarantee the directory tree
    // exists before attempting to write.
    fs.mkdirSync( directory, { recursive: true } )

    sinks.file = getFileSink( absolutePath, { formatter } )
    activeSinks.push( 'file' )
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
  } )
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
export const getAppLogger = ( category ) => getLogger( [ 'waypoint', category ] )

/**
 * Graceful termination hook for the logging pipeline.
 * Rationale: File sinks and remote log aggregators often buffer output asynchronously for
 * performance. During a SIGTERM or unhandled exception, failing to flush these buffers
 * results in dropped logs, destroying post-mortem observability.
 * Side Effect: Triggers an awaited reset across all active LogTape sinks.
 */
export const flushLogs = async () => {
  await reset()
}
