/**
 * @fileoverview Validator class for providers section of configuration.
 * Validates that providers are configured correctly, verify custom base URLs,
 * active API keys, model declarations, aliases, reasoning settings,
 * and fallback models.
 * @module config/ProviderValidator
 */

import { isPositiveInteger, isNonEmptyString, validateFallbackModel } from './validationHelpers.js'
import { filterValidKeys } from './configKeyUtils.js'
import { getAppLogger } from '../logging/logger.js'
import { logErrorAndExitOrThrow } from './validationErrors.js'

const logger = getAppLogger( 'config' )

const SETTINGS_CONFIG = {
  temperature: {
    validate: ( val ) => typeof val === 'number' && val >= 0 && val <= 2,
    errorMsg: ( path, provider ) => `Setting 'temperature' at '${ path }' for provider '${ provider }' must be a number between 0 and 2.`,
  },
  maxTokens: {
    validate: ( val ) => isPositiveInteger( Number( val ) ),
    errorMsg: ( path, provider ) => `Setting 'maxTokens' at '${ path }' for provider '${ provider }' must be a positive integer.`,
  },
  reasoningSupported: {
    validate: ( val ) => typeof val === 'boolean',
    errorMsg: ( path, provider ) => `Setting 'reasoningSupported' at '${ path }' for provider '${ provider }' must be a boolean.`,
  },
  reasoningEffort: {
    validate: ( val ) => {
      const allowed = [ 'minimal', 'low', 'medium', 'high', 'xhigh', 'max' ]
      return typeof val === 'string' && allowed.includes( val.toLowerCase() )
    },
    errorMsg: ( path, provider ) => `Setting 'reasoningEffort' at '${ path }' for provider '${ provider }' must be one of 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'.`,
  },
}

const VALID_SETTING_KEYS = new Set( Object.keys( SETTINGS_CONFIG ) )

const VALID_PROVIDER_TYPES = [ 'openai-compatible', 'anthropic-compatible' ]

const VALID_MODEL_KEYS = [
  'id',
  'aliases',
  'actualModelId',
  'fallbackModel',
  'overrides',
  'temperature',
  'maxTokens',
  'reasoningSupported',
  'reasoningEffort',
]

/**
 * Class representing a validator for API providers.
 */
export class ProviderValidator {
  /**
   * Creates an instance of ProviderValidator.
   * @param {Set<string>} reservedProviders - Set of built-in reserved provider names.
   */
  constructor ( reservedProviders ) {
    this.reservedProviders = reservedProviders
  }

  /**
   * Validates the providers configuration block.
   *
   * @param {Object} providers - The providers configuration block from config file.
   * @param {boolean} shouldExit - Whether the process should exit on validation failure.
   * @param {Object|null} customLogger - Logger instance for warning/error reporting.
   * @throws {Error} Throws validation errors if shouldExit is false.
   * @returns {Object} Processed providers config
   */
  validate( providers, shouldExit ) {
    if (
      !providers
      || typeof providers !== 'object'
      || Object.keys( providers ).length === 0
    ) {
      logErrorAndExitOrThrow( "Configuration must define at least one provider under 'providers'.", shouldExit )
    }

    const processedProviders = structuredClone( providers )
    const originalProviders = new Set( Object.keys( processedProviders ) )

    Object.entries( processedProviders ).forEach( ( [ providerName, providerConf ] ) => {
      if ( !providerConf || typeof providerConf !== 'object' ) {
        logErrorAndExitOrThrow( `Invalid configuration for provider '${ providerName }'.`, shouldExit )
      }

      if ( this.reservedProviders.has( providerName ) ) {
        if ( providerConf.type !== undefined ) {
          const msg = `WARNING: Reserved provider '${ providerName }' does not accept a 'type' field. It will be ignored.`
          logger.warning( msg )
          delete providerConf.type
        }
      } else if ( providerConf.type === undefined ) {
        providerConf.type = 'openai-compatible'
      } else if ( !VALID_PROVIDER_TYPES.includes( providerConf.type ) ) {
        logErrorAndExitOrThrow(
          `Invalid 'type' value '${ providerConf.type }' for custom provider '${ providerName }'. unknown provider type.`,
          shouldExit,
        )
      }

      if ( !this.reservedProviders.has( providerName ) && !isNonEmptyString( providerConf.baseUrl ) ) {
        logErrorAndExitOrThrow(
          `Provider '${ providerName }' is a custom provider and must specify a non-empty 'baseUrl'. custom provider requires baseUrl.`,
          shouldExit,
        )
      }

      if ( Array.isArray( providerConf.keys ) ) {
        const originalLength = providerConf.keys.length
        const validKeys = filterValidKeys( providerConf.keys, providerName, logger )
        if ( validKeys.length !== originalLength ) {
          providerConf.keys = validKeys
        }
      }

      if ( !Array.isArray( providerConf.keys ) || providerConf.keys.length === 0 ) {
        logErrorAndExitOrThrow(
          `Provider '${ providerName }' has zero active keys remaining in the pool.`,
          shouldExit,
        )
        return
      }

      if ( !providerConf.models || !Array.isArray( providerConf.models )
        || providerConf.models.length === 0 ) {
        logErrorAndExitOrThrow( `Provider '${ providerName }' must have a non-empty 'models' array.`, shouldExit )
      }

      providerConf.models.forEach( ( model, j ) => {
        if ( !model || typeof model !== 'object' ) {
          logErrorAndExitOrThrow( `Invalid model at index ${ j } for provider '${ providerName }'.`, shouldExit )
        }
        if ( !isNonEmptyString( model.id ) ) {
          logErrorAndExitOrThrow( `Missing or empty model 'id' at index ${ j } for provider '${ providerName }'.`, shouldExit )
        }

        Object.entries( model ).forEach( ( [ key, val ] ) => {
          if ( !VALID_MODEL_KEYS.includes( key ) ) {
            logErrorAndExitOrThrow(
              `Invalid model configuration key '${ key }' at index ${ j } for provider '${ providerName }'.`,
              shouldExit,
            )
          }

          if ( key === 'aliases' ) {
            if ( !Array.isArray( val ) ) {
              logErrorAndExitOrThrow(
                `Invalid 'aliases' at index ${ j } for provider '${ providerName }'. Must be an array.`,
                shouldExit,
              )
            }
          } else if ( key === 'actualModelId' ) {
            if ( !isNonEmptyString( val ) ) {
              logErrorAndExitOrThrow(
                `Invalid 'actualModelId' at index ${ j } for provider '${ providerName }'. Must be a non-empty string.`,
                shouldExit,
              )
            }
          } else if ( VALID_SETTING_KEYS.has( key ) ) {
            ProviderValidator.validateSettings(
              { [ key ]: val },
              `models[${ j }]`,
              providerName,
              shouldExit,
            )
          } else if ( key === 'overrides' ) {
            ProviderValidator.validateSettings( val, `models[${ j }].overrides`, providerName, shouldExit )
          }
        } )

        if ( model.fallbackModel !== undefined ) {
          validateFallbackModel(
            model,
            j,
            providerName,
            processedProviders,
            originalProviders,
            shouldExit,
          )
        }
      } )
    } )

    return processedProviders
  }

  /**
   * Validates a settings block (defaults or overrides) for a model.
   *
   * @param {Object} settings - The settings configuration object.
   * @param {string} path - The path identifier for error messages.
   * @param {string} providerName - The provider name.
   * @param {boolean} shouldExit - Whether the process should exit on validation failure.
   * @param {Object|null} customLogger - Logger instance.
   */
  static validateSettings( settings, path, providerName, shouldExit ) {
    if ( !settings || typeof settings !== 'object' || Array.isArray( settings ) ) {
      logErrorAndExitOrThrow(
        `Invalid settings object at '${ path }' for provider '${ providerName }'.`,
        shouldExit,
      )
      return
    }

    Object.entries( settings ).forEach( ( [ key, val ] ) => {
      if ( !VALID_SETTING_KEYS.has( key ) ) {
        logErrorAndExitOrThrow(
          `Invalid setting key '${ key }' at '${ path }' for provider '${ providerName }'.`,
          shouldExit,
        )
      }
      if ( !SETTINGS_CONFIG[ key ].validate( val ) ) {
        logErrorAndExitOrThrow(
          SETTINGS_CONFIG[ key ].errorMsg( path, providerName ),
          shouldExit,
        )
      }
    } )
  }
}
