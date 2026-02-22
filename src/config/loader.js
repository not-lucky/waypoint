import fs from 'node:fs';
import yaml from 'js-yaml';
import { isDeepStrictEqual } from 'node:util';

// Reserved provider names.
// These providers map to official SDKs and do not require a base_url.
const RESERVED_PROVIDERS = new Set(['gemini', 'anthropic', 'openai']);

// Export node's built-in deep compare as isDeepEqual.
export { isDeepStrictEqual as isDeepEqual };

const VAR_REGEX = /\$\{([A-Za-z0-9_]+)\}/g;

/**
 * Replaces all ${VAR} placeholders in a string with their process.env values.
 *
 * @param {string} str - The string containing placeholders.
 * @returns {string} The string with all placeholders resolved.
 */
const replaceEnvVars = (str) => {
  return str.replace(VAR_REGEX, (_, varName) => process.env[varName]);
};

/**
 * Scans a string for environment variable placeholders and returns the name of
 * the first one that is missing or empty in the environment.
 * 
 * @param {string} str - The string to check.
 * @returns {string|null} The name of the missing env var, or null if all exist.
 */
const getMissingEnvVar = (str) => {
  const matches = [...str.matchAll(VAR_REGEX)];
  for (const match of matches) {
    const varName = match[1];
    const envVal = process.env[varName];
    // Do not change to `!envVal?.trim()`. 
    // In test environments, process.env values are sometimes mocked as numbers or other 
    // non-string types. Calling .trim() directly on them will throw a TypeError.
    if (envVal === undefined || String(envVal).trim() === '') {
      return varName;
    }
  }
  return null;
};

/**
 * Coerces a specific property of an object to an integer if it's a string of digits.
 * 
 * @param {object} obj - The target object.
 * @param {string} key - The property key.
 */
const coerceToInt = (obj, key) => {
  if (obj && typeof obj[key] === 'string' && /^\d+$/.test(obj[key])) {
    obj[key] = parseInt(obj[key], 10);
  }
};

export const deepFreeze = (obj) => {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (obj instanceof Date) {
    const mutators = [
      'setDate', 'setFullYear', 'setHours', 'setMilliseconds', 'setMinutes',
      'setMonth', 'setSeconds', 'setTime', 'setUTCDate', 'setUTCFullYear',
      'setUTCHours', 'setUTCMilliseconds', 'setUTCMinutes', 'setUTCMonth',
      'setUTCSeconds'
    ];
    for (const m of mutators) {
      obj[m] = () => {
        throw new TypeError('Cannot modify a frozen Date');
      };
    }
    Object.freeze(obj);
    return obj;
  }

  if (obj instanceof Map) {
    obj.set = obj.delete = obj.clear = () => {
      throw new TypeError('Cannot modify a frozen Map');
    };
    Object.freeze(obj);
    for (const [key, val] of obj.entries()) {
      deepFreeze(key);
      deepFreeze(val);
    }
    return obj;
  }

  if (obj instanceof Set) {
    obj.add = obj.delete = obj.clear = () => {
      throw new TypeError('Cannot modify a frozen Set');
    };
    Object.freeze(obj);
    for (const val of obj.values()) {
      deepFreeze(val);
    }
    return obj;
  }

  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key]);
  }
  return obj;
}

/**
 * Compares critical structural gateway and logging configuration values.
 * 
 * @param {object} oldConf - Previous configuration state.
 * @param {object} newConf - New configuration state.
 * @returns {boolean} True if structural fields changed, otherwise false.
 */
const checkStructuralChanges = (oldConf, newConf) => {
  if (!oldConf || !newConf) return false;
  return (
    oldConf.gateway?.port !== newConf.gateway?.port ||
    oldConf.gateway?.max_payload_size !== newConf.gateway?.max_payload_size ||
    !isDeepStrictEqual(oldConf.gateway?.cors, newConf.gateway?.cors) ||
    !isDeepStrictEqual(oldConf.logging, newConf.logging)
  );
};

const logErrorAndExitOrThrow = (msg, shouldExit) => {
  if (shouldExit) {
    console.error(`FATAL ERROR: ${msg}`);
    process.exit(1);
  }
  throw new Error(msg);
};

const isPositiveInteger = (val) => Number.isInteger(val) && val > 0;

const isNonEmptyString = (val) => typeof val === 'string' && val.trim() !== '';

const matchesModelId = (model, fallbackModelId) => model.id === fallbackModelId || (Array.isArray(model.aliases) && model.aliases.includes(fallbackModelId));

const validateFallbackModel = (model, modelIndex, providerName, providers, originalProviders, shouldExit) => {
  const fallbackRef = model.fallback_model;

  if (!isNonEmptyString(fallbackRef)) {
    logErrorAndExitOrThrow(`Invalid 'fallback_model' at index ${modelIndex} for provider '${providerName}'. Must be a non-empty string.`, shouldExit);
  }

  const [fallbackProvider, fallbackModelId, ...rest] = fallbackRef.split('/');
  if (!fallbackProvider?.trim() || !fallbackModelId?.trim() || rest.length > 0) {
    logErrorAndExitOrThrow(`Invalid 'fallback_model' format '${fallbackRef}' at index ${modelIndex} for provider '${providerName}'. Must be in 'provider/model-id' format.`, shouldExit);
  }

  const targetProvider = providers[fallbackProvider];
  if (!targetProvider) {
    if (originalProviders.has(fallbackProvider)) {
      return true;
    }
    logErrorAndExitOrThrow(`Invalid 'fallback_model' reference '${fallbackRef}' at index ${modelIndex} for provider '${providerName}': provider '${fallbackProvider}' does not exist in configuration.`, shouldExit);
  }

  const hasMatchingModel = Array.isArray(targetProvider.models) && targetProvider.models.some(m => matchesModelId(m, fallbackModelId));
  if (!hasMatchingModel) {
    logErrorAndExitOrThrow(`Invalid 'fallback_model' reference '${fallbackRef}' at index ${modelIndex} for provider '${providerName}': model ID or alias '${fallbackModelId}' does not exist in provider '${fallbackProvider}'.`, shouldExit);
  }

  if (fallbackProvider === providerName && matchesModelId(model, fallbackModelId)) {
    logErrorAndExitOrThrow(`Invalid 'fallback_model' reference '${fallbackRef}' at index ${modelIndex} for provider '${providerName}': model cannot fall back to itself.`, shouldExit);
  }

  return false;
}

export const validateConfig = (config, shouldExit = true, reservedProviders = RESERVED_PROVIDERS) => {
  if (!config) {
    logErrorAndExitOrThrow("Configuration object is null or undefined.", shouldExit);
  }

  if (!config.gateway || typeof config.gateway !== 'object') {
    logErrorAndExitOrThrow("Missing structural field 'gateway'.", shouldExit);
  }

  if (!isPositiveInteger(config.gateway.port)) {
    logErrorAndExitOrThrow("Missing or invalid 'gateway.port'. Must be a positive integer.", shouldExit);
  }

  if (config.gateway.global_retry_limit !== undefined && !isPositiveInteger(config.gateway.global_retry_limit)) {
    logErrorAndExitOrThrow("Invalid 'gateway.global_retry_limit'. Must be a positive integer.", shouldExit);
  }

  if (config.gateway.cooldown !== undefined) {
    if (typeof config.gateway.cooldown !== 'object' || config.gateway.cooldown === null) {
      logErrorAndExitOrThrow("Invalid 'gateway.cooldown'. Must be an object.", shouldExit);
    }

    const { base_seconds, max_seconds } = config.gateway.cooldown;
    if (base_seconds !== undefined && !isPositiveInteger(base_seconds)) {
      logErrorAndExitOrThrow("Invalid 'gateway.cooldown.base_seconds'. Must be a positive integer.", shouldExit);
    }
    if (max_seconds !== undefined && !isPositiveInteger(max_seconds)) {
      logErrorAndExitOrThrow("Invalid 'gateway.cooldown.max_seconds'. Must be a positive integer.", shouldExit);
    }
  }

  if (config.gateway.routing !== undefined) {
    if (typeof config.gateway.routing !== 'object' || config.gateway.routing === null) {
      logErrorAndExitOrThrow("Invalid structural field 'gateway.routing'. Must be an object.", shouldExit);
    }
    const strategy = config.gateway.routing.strategy;
    if (strategy !== undefined && strategy !== 'round-robin' && strategy !== 'fill-first') {
      logErrorAndExitOrThrow(`Invalid routing strategy '${strategy}'. Supported strategies: 'round-robin', 'fill-first'.`, shouldExit);
    }
  }

  if (!config.clients || !Array.isArray(config.clients)) {
    logErrorAndExitOrThrow("Missing structural field 'clients'.", shouldExit);
  }

  for (let i = 0; i < config.clients.length; i++) {
    const client = config.clients[i];
    if (!client || typeof client !== 'object') {
      logErrorAndExitOrThrow(`Invalid client configuration at index ${i}.`, shouldExit);
    }
    if (!isNonEmptyString(client.token)) {
      logErrorAndExitOrThrow(`Missing or empty 'token' for client at index ${i}.`, shouldExit);
    }
    if (!client.rate_limit || typeof client.rate_limit !== 'object') {
      logErrorAndExitOrThrow(`Missing structural field 'rate_limit' for client at index ${i}.`, shouldExit);
    }
    if (!isPositiveInteger(client.rate_limit.window_ms)) {
      logErrorAndExitOrThrow(`Invalid or missing 'rate_limit.window_ms' for client at index ${i}. Must be a positive integer.`, shouldExit);
    }
    if (!isPositiveInteger(client.rate_limit.max)) {
      logErrorAndExitOrThrow(`Invalid or missing 'rate_limit.max' for client at index ${i}. Must be a positive integer.`, shouldExit);
    }
  }

  if (!config.logging || typeof config.logging !== 'object') {
    logErrorAndExitOrThrow("Missing structural field 'logging'.", shouldExit);
  }
  if (typeof config.logging.enable_console !== 'boolean') {
    logErrorAndExitOrThrow("Invalid or missing 'logging.enable_console'. Must be a boolean.", shouldExit);
  }
  if (typeof config.logging.enable_file !== 'boolean') {
    logErrorAndExitOrThrow("Invalid or missing 'logging.enable_file'. Must be a boolean.", shouldExit);
  }
  if (config.logging.enable_file && !isNonEmptyString(config.logging.file_path)) {
    logErrorAndExitOrThrow("Invalid or missing 'logging.file_path'. Must be a non-empty string.", shouldExit);
  }
  if (config.logging.format !== 'json' && config.logging.format !== 'text') {
    logErrorAndExitOrThrow("Invalid or missing 'logging.format'. Must be 'json' or 'text'.", shouldExit);
  }

  if (!config.providers || typeof config.providers !== 'object' || Object.keys(config.providers).length === 0) {
    logErrorAndExitOrThrow("Configuration must define at least one provider under 'providers'.", shouldExit);
  }

  const originalProviders = new Set(Object.keys(config.providers));

  Object.entries(config.providers).forEach(([providerName, providerConf]) => {
    if (!providerConf || typeof providerConf !== 'object') {
      logErrorAndExitOrThrow(`Invalid configuration for provider '${providerName}'.`, shouldExit);
    }

    if (!reservedProviders.has(providerName) && !isNonEmptyString(providerConf.base_url)) {
      logErrorAndExitOrThrow(`Provider '${providerName}' is a custom provider and must specify a non-empty 'base_url'.`, shouldExit);
    }

    if (!Array.isArray(providerConf.keys) || providerConf.keys.length === 0) {
      console.warn(`WARNING: Provider '${providerName}' has zero active keys. Skipping provider.`);
      delete config.providers[providerName];
      return;
    }

    if (!providerConf.models || !Array.isArray(providerConf.models) || providerConf.models.length === 0) {
      logErrorAndExitOrThrow(`Provider '${providerName}' must have a non-empty 'models' array.`, shouldExit);
    }

    providerConf.models.forEach((model, j) => {
      if (!model || typeof model !== 'object') {
        logErrorAndExitOrThrow(`Invalid model at index ${j} for provider '${providerName}'.`, shouldExit);
      }
      if (!isNonEmptyString(model.id)) {
        logErrorAndExitOrThrow(`Missing or empty model 'id' at index ${j} for provider '${providerName}'.`, shouldExit);
      }
      if (!isNonEmptyString(model.actual_model_id)) {
        logErrorAndExitOrThrow(`Missing or empty model 'actual_model_id' at index ${j} for provider '${providerName}'.`, shouldExit);
      }
      if (model.aliases !== undefined && !Array.isArray(model.aliases)) {
        logErrorAndExitOrThrow(`Invalid 'aliases' at index ${j} for provider '${providerName}'. Must be an array.`, shouldExit);
      }
      if (model.thinking_supported !== undefined && typeof model.thinking_supported !== 'boolean') {
        logErrorAndExitOrThrow(`Invalid 'thinking_supported' at index ${j} for provider '${providerName}'. Must be a boolean.`, shouldExit);
      }
      if (model.default_thinking_budget !== undefined && !isPositiveInteger(model.default_thinking_budget)) {
        logErrorAndExitOrThrow(`Invalid 'default_thinking_budget' at index ${j} for provider '${providerName}'. Must be a positive integer.`, shouldExit);
      }

      if (model.fallback_model !== undefined) {
        validateFallbackModel(model, j, providerName, config.providers, originalProviders, shouldExit);
      }
    });
  });
}

/**
 * ConfigLoader manages parsing, environment variable interpolation, validation,
 * and hot-reloading of configuration files.
 */
export class ConfigLoader {
  constructor() {
    this.currentConfig = null;
    this.currentConfigPath = null;
    this.isWatching = false;
    this.watcher = null;
    this.listeners = [];
    this.debounceTimeout = null;
  }

  /**
   * Loads the YAML configuration file, parses it, interpolates env variables,
   * and sets up hot-reloading file watch.
   * Fails fast and terminates process if configuration is invalid at startup.
   */
  loadConfig(configPath = 'config/config.yaml', reservedProviders = RESERVED_PROVIDERS) {
    if (this.currentConfig) {
      return this.currentConfig;
    }

    this.currentConfigPath = configPath;
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = yaml.load(raw);
      this.currentConfig = deepFreeze(this.interpolateAndValidate(parsed, reservedProviders));
    } catch (err) {
      // Initial startup validation failure: log fatal error and abort startup.
      console.error(`FATAL ERROR: Failed to load config file at ${configPath}: ${err.message}`);
      process.exit(1);
    }

    this.startWatcher(configPath, reservedProviders);

    return this.currentConfig;
  }

  /**
   * Registers a callback to be triggered when the configuration changes.
   */
  onConfigChange(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(listener => listener !== callback);
    };
  }

  /**
   * Stops watching the configuration file and clears any listeners.
   */
  stopWatcher() {
    this.isWatching = false;
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch (e) {
        // ignore close error
      }
      this.watcher = null;
    }
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
      this.debounceTimeout = null;
    }
    this.listeners = [];
  }

  /**
   * Resets the loader module state.
   */
  resetConfig() {
    this.stopWatcher();
    this.currentConfig = null;
    this.currentConfigPath = null;
  }

  /**
   * Performs configuration validation, validates provider specifications,
   * handles environment variable interpolation, and coerces types.
   */
  interpolateAndValidate(parsedYaml, reservedProviders = RESERVED_PROVIDERS) {
    if (!parsedYaml || typeof parsedYaml !== 'object') {
      throw new Error("Invalid configuration structure.");
    }

    // Deep clone to avoid mutating the original parsed object directly before validation.
    const workingConfig = structuredClone(parsedYaml);
    const interpolated = this.interpolate(workingConfig);

    // Coerce numeric properties from environment variables
    this.coerceNumericProperties(interpolated);

    // Call validateConfig with shouldExit = false
    validateConfig(interpolated, false, reservedProviders);

    return interpolated;
  }

  /**
   * Coerces numeric properties that might have been interpolated as strings.
   */
  coerceNumericProperties(config) {
    if (!config) return;

    if (config.gateway) {
      coerceToInt(config.gateway, 'port');
      coerceToInt(config.gateway, 'global_retry_limit');
      coerceToInt(config.gateway.cooldown, 'base_seconds');
      coerceToInt(config.gateway.cooldown, 'max_seconds');
    }

    if (Array.isArray(config.clients)) {
      config.clients.forEach(client => {
        coerceToInt(client?.rate_limit, 'window_ms');
        coerceToInt(client?.rate_limit, 'max');
      });
    }

    if (config.providers && typeof config.providers === 'object') {
      Object.values(config.providers).forEach(providerConf => {
        if (Array.isArray(providerConf?.models)) {
          providerConf.models.forEach(model => {
            coerceToInt(model, 'default_thinking_budget');
          });
        }
      });
    }
  }

  /**
   * Recursively traverses a configuration node to interpolate env variables.
   * Filters invalid keys (literal empty string, missing env vars, null, undefined) in provider keys.
   */
  interpolate(val, path = []) {
    if (Array.isArray(val)) {
      if (path.at(-1) === 'keys') {
        const providerName = path.at(-2);
        return val.flatMap((item, i) => {
          if (item == null || (typeof item === 'string' && item.trim() === '')) {
            console.warn(`WARNING: Skipping undefined or empty key for provider '${providerName}' at index ${i}.`);
            return [];
          }

          if (typeof item !== 'string') {
            return [String(item)];
          }

          const missingVar = getMissingEnvVar(item);
          if (missingVar) {
            console.warn(`WARNING: Missing or empty environment variable ${missingVar} for key at path ${path.join('.')}[${i}]. Skipping key.`);
            return [];
          }

          return [replaceEnvVars(item)];
        });
      }
      return val.map((item, index) => this.interpolate(item, [...path, index]));
    }

    if (val && typeof val === 'object') {
      return Object.fromEntries(
        Object.entries(val).map(([key, child]) => [key, this.interpolate(child, [...path, key])])
      );
    }

    if (typeof val === 'string') {
      const missingVar = getMissingEnvVar(val);
      if (missingVar) {
        throw new Error(`Missing or empty environment variable ${missingVar} at configuration path ${path.join('.')}`);
      }
      return replaceEnvVars(val);
    }

    return val;
  }

  /**
   * Starts the fs.watch process on the config file.
   * Handles 'rename' event by closing the old watcher and re-initializing to address atomic saves.
   */
  startWatcher(configPath, reservedProviders = RESERVED_PROVIDERS) {
    if (this.isWatching) {
      return;
    }
    this.isWatching = true;
    this.currentConfigPath = configPath;

    let retryCount = 0;
    const setupWatch = () => {
      if (this.watcher) {
        try {
          this.watcher.close();
        } catch (e) {
          // ignore close error
        }
        this.watcher = null;
      }

      if (!this.isWatching) return;

      try {
        this.watcher = fs.watch(configPath, (eventType) => {
          if (eventType === 'rename') {
            // Atomic save detected (rename). Re-initialize watcher on the file path.
            setTimeout(() => {
              setupWatch();
              this.handleConfigChange(configPath, reservedProviders);
            }, 50);
          } else if (eventType === 'change') {
            this.handleConfigChange(configPath, reservedProviders);
          }
        });
        retryCount = 0;
      } catch (err) {
        retryCount++;
        if (retryCount >= 5) {
          console.warn(`WARNING: Stopped watching configuration file after 5 failed attempts.`);
          this.stopWatcher();
          return;
        }
        // If file is temporarily missing or locked during rename, retry after a delay.
        setTimeout(setupWatch, 100);
      }
    };

    setupWatch();
  }

  /**
   * Handles file content changes with debouncing to prevent race conditions during write cycles.
   */
  handleConfigChange(configPath, reservedProviders) {
    if (this.debounceTimeout) clearTimeout(this.debounceTimeout);

    this.debounceTimeout = setTimeout(() => {
      try {
        if (!fs.existsSync(configPath)) {
          return;
        }
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = yaml.load(raw);
        const newConfig = deepFreeze(this.interpolateAndValidate(parsed, reservedProviders));

        // Warn if port or other structural parameters changed.
        const structuralChanged = checkStructuralChanges(this.currentConfig, newConfig);
        if (structuralChanged) {
          console.warn("WARNING: Structural configuration changed. A process restart is required to apply these changes.");
        }

        // Swap configuration references atomically to prevent request-processing race conditions.
        const oldConfig = this.currentConfig;
        this.currentConfig = newConfig;

        // Notify all registered change subscribers.
        for (const listener of this.listeners) {
          try {
            listener(this.currentConfig, oldConfig);
          } catch (err) {
            console.error("Error in config change listener:", err);
          }
        }
      } catch (err) {
        // At runtime, we catch validation errors and keep the server process online.
        console.error(`Error reloading configuration file on change: ${err.message}`);
      }
    }, 100);
  }
}
