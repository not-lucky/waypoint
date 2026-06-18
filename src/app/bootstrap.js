import { ConfigLoader } from '../config/loader.js'
import { configureLogging, getAppLogger } from '../logging/logger.js'
import { registerLifecycle } from '../lifecycle/lifecycle.js'
import { wireServices } from './wireServices.js'
import { createApp } from './createApp.js'

export async function bootstrap() {
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
  } catch ( _err ) {
    // Application-level exit decision here
    process.exit( 1 )
  }
}
