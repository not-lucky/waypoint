import { ConfigLoader } from '../config/loader.js'
import { configureLogging, flushLogs, getAppLogger } from '../logging/logger.js'
import { registerLifecycle } from '../lifecycle/lifecycle.js'
import { wireServices } from './wireServices.js'
import { createApp } from './createApp.js'

const FATAL_EXIT_CODE = 1

const logFatal = async ( err ) => {
  // LogTape may not be wired yet (e.g. config load failure), so fall back to stderr.
  console.error( `[FATAL] Waypoint bootstrap failed: ${ err?.stack || err?.message || err }` )
  try {
    await flushLogs()
  } catch {
    // Suppress secondary errors during emergency flush.
  }
}

const handleUncaught = ( source ) => async ( err ) => {
  console.error( `[FATAL] Unhandled ${ source } during request lifecycle:`, err )
  try {
    await flushLogs()
  } catch {
    // Suppress secondary errors during emergency flush.
  }
  process.exit( FATAL_EXIT_CODE )
}

let safetyNetsInstalled = false

const installSafetyNets = () => {
  if ( safetyNetsInstalled ) return
  safetyNetsInstalled = true
  process.on( 'uncaughtException', handleUncaught( 'exception' ) )
  process.on( 'unhandledRejection', handleUncaught( 'rejection' ) )
}

export async function bootstrap () {
  installSafetyNets()

  try {
    const config = new ConfigLoader().loadConfig()

    await configureLogging( config )
    const logger = getAppLogger( 'server' )
    logger.debug( 'Configuration loaded successfully' )

    const services = wireServices( config )
    const app = createApp( config, services, logger )

    const { port } = config.gateway
    logger.debug( 'Initializing Express app listening...' )
    const server = app.listen( port, () => {
      logger.info( `Waypoint listening on port ${ port }` )
    } )

    registerLifecycle( {
      server,
      keyRegistry: services.keyRegistry,
      logger,
    } )

    return {
      app,
      server,
      keyRegistry: services.keyRegistry,
      config,
      logger,
    }
  } catch ( err ) {
    await logFatal( err )
    process.exit( FATAL_EXIT_CODE )
  }
}
