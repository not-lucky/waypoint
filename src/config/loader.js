import fs from 'node:fs'
import yaml from 'js-yaml'
import { getAppLogger } from '../infrastructure/logging/logger.js'
import {
  RESERVED_PROVIDERS,
  replaceEnvVars,
  getMissingEnvVar,
  processProviders,
  processClient,
  processGateway,
  interpolateProviderKeyEntry,
} from './configUtils.js'
import {
  filterValidKeys,
  getProviderKeyCandidate,
} from './configKeyUtils.js'
import { validateConfig } from './validator.js'

const logger = getAppLogger( 'config' )

/**
 * ConfigLoader manages parsing, environment variable interpolation, and validation
 * of configuration files.
 */
export class ConfigLoader {
  constructor () {
    this.currentConfig = null
    this.currentConfigPath = null
  }

  /**
   * Loads the YAML configuration file, parses it, and interpolates env variables.
   * Fails fast and terminates process if configuration is invalid at startup.
   */
  loadConfig(
    configPath = process.env.WAYPOINT_CONFIG_PATH || 'config/config.yaml',
    reservedProviders = RESERVED_PROVIDERS,
  ) {
    if ( this.currentConfig ) {
      return this.currentConfig
    }

    this.currentConfigPath = configPath
    try {
      logger.debug( `Reading configuration file from path: ${ configPath }` )
      const raw = fs.readFileSync( configPath, 'utf8' )
      const parsed = yaml.load( raw )
      this.currentConfig = this.interpolateAndValidate( parsed, reservedProviders )
    } catch ( err ) {
      // Initial startup validation failure: log fatal error and throw.
      logger.fatal( `FATAL ERROR: Failed to load config file at ${ configPath }: ${ err.message }` )
      throw new Error( `Failed to load config file at ${ configPath }: ${ err.message }` )
    }

    return this.currentConfig
  }

  /**
   * Resets the loader module state.
   */
  resetConfig() {
    this.currentConfig = null
    this.currentConfigPath = null
  }

  /**
   * Performs configuration validation, validates provider specifications,
   * handles environment variable interpolation, and coerces types.
   */
  interpolateAndValidate( parsedYaml, reservedProviders = RESERVED_PROVIDERS ) {
    if ( !parsedYaml || typeof parsedYaml !== 'object' ) {
      throw new Error( 'Invalid configuration structure.' )
    }

    // Deep clone to avoid mutating the original parsed object directly before validation.
    const workingConfig = structuredClone( parsedYaml )
    const interpolated = this.interpolate( workingConfig )

    // Coerce numeric properties immutably
    const coerced = ConfigLoader.coerceNumericProperties( interpolated )

    // Call validateConfig with shouldExit = false for test flexibility.
    validateConfig( coerced, false, reservedProviders )

    return coerced
  }

  /**
   * Coerces numeric configuration properties from string to integer immutably.
   * Handles nested numeric properties across gateway, clients, and providers.
   * @param {object} config - The configuration object to process
   * @returns {object} A new configuration object with numeric properties coerced
   */
  static coerceNumericProperties( config ) {
    if ( !config ) return config

    const processedConfig = { ...config }

    if ( processedConfig.gateway ) {
      processedConfig.gateway = processGateway( processedConfig.gateway )
    }

    if ( Array.isArray( processedConfig.clients ) ) {
      processedConfig.clients = processedConfig.clients.map( processClient )
    }

    if ( processedConfig.providers && typeof processedConfig.providers === 'object' ) {
      processedConfig.providers = processProviders( processedConfig.providers )
    }

    return processedConfig
  }

  /**
   * Recursively traverses a configuration node to interpolate env variables.
   * Filters invalid keys (empty string, missing env vars, null, undefined) in provider keys.
   */
  interpolate( val, path = [] ) {
    if ( Array.isArray( val ) ) {
      if ( path.at( -1 ) === 'keys' ) {
        const providerName = path.at( -2 )
        const entries = filterValidKeys(
          val.map( ( item, index ) => ( { item, index } ) ),
          providerName,
          logger,
          ( { item } ) => getProviderKeyCandidate( item ),
        )

        return entries.flatMap( ( { item, index } ) => {
          const interpolated = interpolateProviderKeyEntry( item, path, index, providerName )
          return interpolated === null ? [] : [ interpolated ]
        } )
      }
      return val.map( ( item, index ) => this.interpolate( item, [ ...path, index ] ) )
    }

    if ( val && typeof val === 'object' ) {
      return Object.fromEntries(
        Object.entries( val ).map( ( [ key, child ] ) => [ key, this.interpolate( child, [ ...path, key ] ) ] ),
      )
    }

    if ( typeof val === 'string' ) {
      const missingVar = getMissingEnvVar( val )
      if ( missingVar ) {
        throw new Error(
          `Missing or empty environment variable ${ missingVar } at configuration path ${ path.join( '.' ) }`,
        )
      }
      const resolved = replaceEnvVars( val )
      logger.debug( `Interpolated config value at ${ path.join( '.' ) }` )
      return resolved
    }

    return val
  }
}
