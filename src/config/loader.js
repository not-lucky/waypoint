import fs from 'node:fs';
import yaml from 'js-yaml';
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
 * Processes model numeric properties.
 * @param {object} model - Model configuration
 * @returns {object} Processed model config
 */
function processModel(model) {
  let processed = { ...model };

  processed = coerceToInt(processed, 'maxTokens');

  if (processed.overrides && typeof processed.overrides === 'object') {
    let overrides = { ...processed.overrides };
    overrides = coerceToInt(overrides, 'maxTokens');
    processed = { ...processed, overrides };
  }

  return processed;
}

/**
 * Processes individual provider numeric properties.
 * @param {object} providerConf - Single provider configuration
 * @returns {object} Processed provider config
 */
function processProvider(providerConf) {
  const processed = { ...providerConf };

  if (Array.isArray(processed.models)) {
    processed.models = processed.models.map((model) => processModel(model));
  }

  return processed;
}

/**
 * Processes providers numeric properties.
 * @param {object} providers - Providers configuration
 * @returns {object} Processed providers config
 */
function processProviders(providers) {
  return Object.fromEntries(
    Object.entries(providers).map(([name, providerConf]) => [
      name,
      processProvider(providerConf),
    ]),
  );
}

/**
 * Processes client numeric properties.
 * @param {object} client - Client configuration
 * @returns {object} Processed client config
 */
function processClient(client) {
  if (!client) return client;

  const processed = { ...client };

  if (processed.rateLimit) {
    let rateLimit = { ...processed.rateLimit };
    rateLimit = coerceToInt(rateLimit, 'windowMs');
    rateLimit = coerceToInt(rateLimit, 'max');
    processed.rateLimit = rateLimit;
  }

  return processed;
}

/**
 * Processes gateway numeric properties.
 * @param {object} gateway - Gateway configuration
 * @returns {object} Processed gateway config
 */
function processGateway(gateway) {
  let processed = { ...gateway };

  processed = coerceToInt(processed, 'port');
  processed = coerceToInt(processed, 'globalRetryLimit');
  processed = coerceToInt(processed, 'httpTimeoutMs');

  if (processed.cooldown) {
    let cooldown = { ...processed.cooldown };
    cooldown = coerceToInt(cooldown, 'baseSeconds');
    cooldown = coerceToInt(cooldown, 'maxSeconds');
    processed = { ...processed, cooldown };
  }

  return processed;
}

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
  loadConfig(
    configPath = process.env.WAYPOINT_CONFIG_PATH || 'config/config.yaml',
    reservedProviders = RESERVED_PROVIDERS,
  ) {
    if (this.currentConfig) {
      return this.currentConfig;
    }

    this.currentConfigPath = configPath;
    try {
      logDebug(this.logger, `Reading configuration file from path: ${configPath}`);
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = yaml.load(raw);
      this.currentConfig = this.interpolateAndValidate(parsed, reservedProviders);
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
   * Coerces numeric configuration properties from string to integer immutably.
   * Handles nested numeric properties across gateway, clients, and providers.
   * @param {object} config - The configuration object to process
   * @returns {object} A new configuration object with numeric properties coerced
   */
  static coerceNumericProperties(config) {
    if (!config) return config;

    const processedConfig = { ...config };

    if (processedConfig.gateway) {
      processedConfig.gateway = processGateway(processedConfig.gateway);
    }

    if (Array.isArray(processedConfig.clients)) {
      processedConfig.clients = processedConfig.clients.map((client) => processClient(client));
    }

    if (processedConfig.providers && typeof processedConfig.providers === 'object') {
      processedConfig.providers = processProviders(processedConfig.providers);
    }

    return processedConfig;
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
