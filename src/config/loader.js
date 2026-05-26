import fs from 'node:fs';
import yaml from 'js-yaml';
import { deepFreeze } from '../utils/objectUtils.js';
import {
  logDebug,
  logWarning,
  logFatal,
} from './loggerWrapper.js';
import {
  RESERVED_PROVIDERS,
  replaceEnvVars,
  getMissingEnvVar,
  coerceToInt,
} from './utils.js';
import { validateConfig } from './validator.js';

/**
 * ConfigLoader manages parsing, environment variable interpolation, and validation
 * of configuration files.
 */
export class ConfigLoader {
  constructor() {
    this.currentConfig = null;
    this.currentConfigPath = null;
    this.logger = null;
  }

  /**
   * Injects the logger instance after initial config load.
   */
  setLogger(logger) {
    this.logger = logger;
  }

  /**
   * Loads the YAML configuration file, parses it, and interpolates env variables.
   * Fails fast and terminates process if configuration is invalid at startup.
   */
  loadConfig(configPath = process.env.WAYPOINT_CONFIG_PATH || 'config/config.yaml', reservedProviders = RESERVED_PROVIDERS) {
    if (this.currentConfig) {
      return this.currentConfig;
    }

    this.currentConfigPath = configPath;
    try {
      logDebug(this.logger, `Reading configuration file from path: ${configPath}`);
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = yaml.load(raw);
      this.currentConfig = deepFreeze(this.interpolateAndValidate(parsed, reservedProviders));
    } catch (err) {
      // Initial startup validation failure: log fatal error and abort startup.
      logFatal(this.logger, `FATAL ERROR: Failed to load config file at ${configPath}: ${err.message}`);
      process.exit(1);
    }

    return this.currentConfig;
  }

  /**
   * Resets the loader module state.
   */
  resetConfig() {
    this.currentConfig = null;
    this.currentConfigPath = null;
  }

  /**
   * Performs configuration validation, validates provider specifications,
   * handles environment variable interpolation, and coerces types.
   */
  interpolateAndValidate(parsedYaml, reservedProviders = RESERVED_PROVIDERS) {
    if (!parsedYaml || typeof parsedYaml !== 'object') {
      throw new Error('Invalid configuration structure.');
    }

    // Deep clone to avoid mutating the original parsed object directly before validation.
    const workingConfig = structuredClone(parsedYaml);
    const interpolated = this.interpolate(workingConfig);

    // Coerce numeric properties immutably
    const coerced = ConfigLoader.coerceNumericProperties(interpolated);

    // Call validateConfig with shouldExit = false for test flexibility.
    validateConfig(coerced, false, reservedProviders, this.logger);

    return coerced;
  }

  /**
   * Coerces numeric properties immutably.
   */
  static coerceNumericProperties(config) {
    if (!config) return config;

    return {
      ...config,
      ...(config.gateway && {
        gateway: [
          (g) => coerceToInt(g, 'port'),
          (g) => coerceToInt(g, 'globalRetryLimit'),
          (g) => coerceToInt(g, 'httpTimeoutMs'),
          (g) => (g.cooldown ? {
            ...g,
            cooldown: coerceToInt(coerceToInt(g.cooldown, 'baseSeconds'), 'maxSeconds'),
          } : g),
        ].reduce((acc, fn) => fn(acc), config.gateway),
      }),
      ...(Array.isArray(config.clients) && {
        clients: config.clients.map((client) => (client?.rateLimit ? {
          ...client,
          rateLimit: coerceToInt(coerceToInt(client.rateLimit, 'windowMs'), 'max'),
        } : client)),
      }),
      ...(config.providers && typeof config.providers === 'object' && {
        providers: Object.fromEntries(
          Object.entries(config.providers).map(([name, providerConf]) => [
            name,
            {
              ...providerConf,
              ...(Array.isArray(providerConf?.models) && {
                models: providerConf.models.map((model) => {
                  let m = coerceToInt({ ...model }, 'maxTokens');
                  if (m.overrides && typeof m.overrides === 'object') {
                    m = { ...m, overrides: coerceToInt({ ...m.overrides }, 'maxTokens') };
                  }
                  return m;
                }),
              }),
            },
          ]),
        ),
      }),
    };
  }

  /**
   * Recursively traverses a configuration node to interpolate env variables.
   * Filters invalid keys (empty string, missing env vars, null, undefined) in provider keys.
   */
  interpolate(val, path = []) {
    if (Array.isArray(val)) {
      if (path.at(-1) === 'keys') {
        const providerName = path.at(-2);
        return val.flatMap((item, i) => {
          if (item == null || (typeof item === 'string' && item.trim() === '')) {
            const msg = `WARNING: Skipping undefined or empty key for provider '${providerName}' at index ${i}.`;
            logWarning(this.logger, msg);
            return [];
          }

          if (typeof item !== 'string') {
            return [String(item)];
          }

          const missingVar = getMissingEnvVar(item);
          if (missingVar) {
            const msg = `WARNING: Missing or empty environment variable ${missingVar} for key at path ${path.join('.')}[${i}]. Skipping key.`;
            logWarning(this.logger, msg);
            return [];
          }

          return [replaceEnvVars(item)];
        });
      }
      return val.map((item, index) => this.interpolate(item, [...path, index]));
    }

    if (val && typeof val === 'object') {
      return Object.fromEntries(
        Object.entries(val).map(([key, child]) => [key, this.interpolate(child, [...path, key])]),
      );
    }

    if (typeof val === 'string') {
      const missingVar = getMissingEnvVar(val);
      if (missingVar) {
        throw new Error(
          `Missing or empty environment variable ${missingVar} at configuration path ${path.join('.')}`,
        );
      }
      const resolved = replaceEnvVars(val);
      logDebug(this.logger, `Interpolated config value at ${path.join('.')}`);
      return resolved;
    }

    return val;
  }
}
