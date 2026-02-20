import fs from 'fs';
import yaml from 'js-yaml';
import { isDeepStrictEqual } from 'node:util';

// Reserved provider names.
// These providers map to official SDKs and do not require a base_url.
const RESERVED_PROVIDERS = new Set(['gemini', 'anthropic', 'openai']);

// Export node's built-in deep compare as isDeepEqual.
export { isDeepStrictEqual as isDeepEqual };

/**
 * Recursively deep-freezes an object to make it completely immutable.
 * Prevents runtime state corruption and request processing race conditions.
 * Supports Map, Set, and Date.
 * 
 * @param {object} obj - Object to deep freeze.
 * @returns {object} The frozen object.
 */
export function deepFreeze(obj) {
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
      if (typeof obj[m] === 'function') {
        obj[m] = () => {
          throw new TypeError('Cannot modify a frozen Date');
        };
      }
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

  // Freeze the current object.
  Object.freeze(obj);

  // Recursively freeze all properties.
  for (const key of Object.keys(obj)) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      deepFreeze(obj[key]);
    }
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
function checkStructuralChanges(oldConf, newConf) {
  if (!oldConf || !newConf) return false;
  if (oldConf.gateway?.port !== newConf.gateway?.port) return true;
  if (oldConf.gateway?.max_payload_size !== newConf.gateway?.max_payload_size) return true;
  if (!isDeepStrictEqual(oldConf.gateway?.cors, newConf.gateway?.cors)) return true;
  if (!isDeepStrictEqual(oldConf.logging, newConf.logging)) return true;
  return false;
}

/**
 * Helper to log fatal error and exit process, or throw an error.
 * Handles single logging of fatal configuration errors.
 */
function logErrorAndExitOrThrow(msg, shouldExit) {
  if (shouldExit) {
    console.error(`FATAL ERROR: ${msg}`);
    process.exit(1);
  } else {
    throw new Error(msg);
  }
}

/**
 * Validates the configuration object for structural integrity and provider keys.
 * Exits the process with status 1 on fatal structural errors or empty key pools.
 * 
 * @param {object} config - Configuration object to validate.
 * @param {boolean} [shouldExit=true] - Whether to call process.exit(1) on failure or throw an Error.
 * @param {Set<string>} [reservedProviders=RESERVED_PROVIDERS] - Set of reserved provider names.
 */
export function validateConfig(config, shouldExit = true, reservedProviders = RESERVED_PROVIDERS) {
  if (!config) {
    logErrorAndExitOrThrow("Configuration object is null or undefined.", shouldExit);
    return;
  }

  // 1. Validate gateway structure
  if (!config.gateway || typeof config.gateway !== 'object') {
    logErrorAndExitOrThrow("Missing structural field 'gateway'.", shouldExit);
    return;
  }

  if (config.gateway.port === undefined || config.gateway.port === null || config.gateway.port === '') {
    logErrorAndExitOrThrow("Missing structural field 'gateway.port'.", shouldExit);
    return;
  }

  if (typeof config.gateway.port !== 'number' || config.gateway.port <= 0 || !Number.isInteger(config.gateway.port)) {
    logErrorAndExitOrThrow("Invalid 'gateway.port'. Must be a positive integer.", shouldExit);
    return;
  }

  // Validate gateway.routing.strategy (SPEC-3)
  if (config.gateway.routing !== undefined) {
    if (typeof config.gateway.routing !== 'object' || config.gateway.routing === null) {
      logErrorAndExitOrThrow("Invalid structural field 'gateway.routing'. Must be an object.", shouldExit);
      return;
    }
    const strategy = config.gateway.routing.strategy;
    if (strategy !== undefined) {
      if (strategy !== 'round-robin' && strategy !== 'fill-first') {
        logErrorAndExitOrThrow(`Invalid routing strategy '${strategy}'. Supported strategies: 'round-robin', 'fill-first'.`, shouldExit);
        return;
      }
    }
  }

  // 2. Validate clients structure (SPEC-5)
  if (!config.clients || !Array.isArray(config.clients)) {
    logErrorAndExitOrThrow("Missing structural field 'clients'.", shouldExit);
    return;
  }

  for (let i = 0; i < config.clients.length; i++) {
    const client = config.clients[i];
    if (!client || typeof client !== 'object') {
      logErrorAndExitOrThrow(`Invalid client configuration at index ${i}.`, shouldExit);
      return;
    }
    if (client.token === undefined || client.token === null || client.token === '') {
      logErrorAndExitOrThrow(`Missing structural field 'token' for client at index ${i}.`, shouldExit);
      return;
    }

    if (!client.rate_limit || typeof client.rate_limit !== 'object') {
      logErrorAndExitOrThrow(`Missing structural field 'rate_limit' for client at index ${i}.`, shouldExit);
      return;
    }
    if (typeof client.rate_limit.window_ms !== 'number' || client.rate_limit.window_ms <= 0 || !Number.isInteger(client.rate_limit.window_ms)) {
      logErrorAndExitOrThrow(`Invalid or missing 'rate_limit.window_ms' for client at index ${i}. Must be a positive integer.`, shouldExit);
      return;
    }
    if (typeof client.rate_limit.max !== 'number' || client.rate_limit.max <= 0 || !Number.isInteger(client.rate_limit.max)) {
      logErrorAndExitOrThrow(`Invalid or missing 'rate_limit.max' for client at index ${i}. Must be a positive integer.`, shouldExit);
      return;
    }
  }

  // 3. Validate logging block structure (SPEC-4)
  if (!config.logging || typeof config.logging !== 'object') {
    logErrorAndExitOrThrow("Missing structural field 'logging'.", shouldExit);
    return;
  }
  if (typeof config.logging.enable_console !== 'boolean') {
    logErrorAndExitOrThrow("Invalid or missing 'logging.enable_console'. Must be a boolean.", shouldExit);
    return;
  }
  if (typeof config.logging.enable_file !== 'boolean') {
    logErrorAndExitOrThrow("Invalid or missing 'logging.enable_file'. Must be a boolean.", shouldExit);
    return;
  }
  if (config.logging.enable_file) {
    if (typeof config.logging.file_path !== 'string' || config.logging.file_path.trim() === '') {
      logErrorAndExitOrThrow("Invalid or missing 'logging.file_path'. Must be a non-empty string.", shouldExit);
      return;
    }
  }
  if (config.logging.format !== 'json' && config.logging.format !== 'text') {
    logErrorAndExitOrThrow("Invalid or missing 'logging.format'. Must be 'json' or 'text'.", shouldExit);
    return;
  }

  // 4. Validate providers and models structure (SPEC-6, SPEC-7, fallback_model integrity)
  if (!config.providers || typeof config.providers !== 'object' || Object.keys(config.providers).length === 0) {
    logErrorAndExitOrThrow("Configuration must define at least one provider under 'providers'.", shouldExit);
    return;
  }

  for (const [providerName, providerConf] of Object.entries(config.providers)) {
    if (!providerConf || typeof providerConf !== 'object') {
      logErrorAndExitOrThrow(`Invalid configuration for provider '${providerName}'.`, shouldExit);
      return;
    }

    // SPEC-7: Validate base_url for custom provider
    if (!reservedProviders.has(providerName)) {
      if (!providerConf.base_url || typeof providerConf.base_url !== 'string' || providerConf.base_url.trim() === '') {
        logErrorAndExitOrThrow(`Provider '${providerName}' is a custom provider and must specify a non-empty 'base_url'.`, shouldExit);
        return;
      }
    }

    // Ensure provider has active keys
    if (!providerConf.keys || !Array.isArray(providerConf.keys) || providerConf.keys.length === 0) {
      logErrorAndExitOrThrow(`Provider '${providerName}' has zero active keys.`, shouldExit);
      return;
    }

    // SPEC-6: Validate provider models array
    if (!providerConf.models || !Array.isArray(providerConf.models) || providerConf.models.length === 0) {
      logErrorAndExitOrThrow(`Provider '${providerName}' must have a non-empty 'models' array.`, shouldExit);
      return;
    }

    for (let j = 0; j < providerConf.models.length; j++) {
      const model = providerConf.models[j];
      if (!model || typeof model !== 'object') {
        logErrorAndExitOrThrow(`Invalid model at index ${j} for provider '${providerName}'.`, shouldExit);
        return;
      }
      if (typeof model.id !== 'string' || model.id.trim() === '') {
        logErrorAndExitOrThrow(`Missing or empty model 'id' at index ${j} for provider '${providerName}'.`, shouldExit);
        return;
      }
      if (typeof model.actual_model_id !== 'string' || model.actual_model_id.trim() === '') {
        logErrorAndExitOrThrow(`Missing or empty model 'actual_model_id' at index ${j} for provider '${providerName}'.`, shouldExit);
        return;
      }
      if (model.aliases !== undefined && !Array.isArray(model.aliases)) {
        logErrorAndExitOrThrow(`Invalid 'aliases' at index ${j} for provider '${providerName}'. Must be an array.`, shouldExit);
        return;
      }
      if (model.thinking_supported !== undefined && typeof model.thinking_supported !== 'boolean') {
        logErrorAndExitOrThrow(`Invalid 'thinking_supported' at index ${j} for provider '${providerName}'. Must be a boolean.`, shouldExit);
        return;
      }
      if (model.default_thinking_budget !== undefined && (typeof model.default_thinking_budget !== 'number' || model.default_thinking_budget <= 0 || !Number.isInteger(model.default_thinking_budget))) {
        logErrorAndExitOrThrow(`Invalid 'default_thinking_budget' at index ${j} for provider '${providerName}'. Must be a positive integer.`, shouldExit);
        return;
      }

      // fallback_model referential integrity check
      if (model.fallback_model !== undefined) {
        if (typeof model.fallback_model !== 'string' || model.fallback_model.trim() === '') {
          logErrorAndExitOrThrow(`Invalid 'fallback_model' at index ${j} for provider '${providerName}'. Must be a non-empty string.`, shouldExit);
          return;
        }
        const parts = model.fallback_model.split('/');
        if (parts.length !== 2 || parts[0].trim() === '' || parts[1].trim() === '') {
          logErrorAndExitOrThrow(`Invalid 'fallback_model' format '${model.fallback_model}' at index ${j} for provider '${providerName}'. Must be in 'provider/model-id' format.`, shouldExit);
          return;
        }
        const [fallbackProvider, fallbackModel] = parts;
        const targetProvider = config.providers[fallbackProvider];
        if (!targetProvider) {
          logErrorAndExitOrThrow(`Invalid 'fallback_model' reference '${model.fallback_model}' at index ${j} for provider '${providerName}': provider '${fallbackProvider}' does not exist in configuration.`, shouldExit);
          return;
        }
        const hasMatchingModel = Array.isArray(targetProvider.models) && targetProvider.models.some(m => {
          if (!m) return false;
          return m.id === fallbackModel || (Array.isArray(m.aliases) && m.aliases.includes(fallbackModel));
        });
        if (!hasMatchingModel) {
          logErrorAndExitOrThrow(`Invalid 'fallback_model' reference '${model.fallback_model}' at index ${j} for provider '${providerName}': model ID or alias '${fallbackModel}' does not exist in provider '${fallbackProvider}'.`, shouldExit);
          return;
        }
      }
    }
  }
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
      const idx = this.listeners.indexOf(callback);
      if (idx !== -1) {
        this.listeners.splice(idx, 1);
      }
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
    this.listeners.length = 0;
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
    const workingConfig = JSON.parse(JSON.stringify(parsedYaml));
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
      if (typeof config.gateway.port === 'string' && /^\d+$/.test(config.gateway.port)) {
        config.gateway.port = parseInt(config.gateway.port, 10);
      }
      if (typeof config.gateway.global_retry_limit === 'string' && /^\d+$/.test(config.gateway.global_retry_limit)) {
        config.gateway.global_retry_limit = parseInt(config.gateway.global_retry_limit, 10);
      }
      if (config.gateway.cooldown) {
        if (typeof config.gateway.cooldown.base_seconds === 'string' && /^\d+$/.test(config.gateway.cooldown.base_seconds)) {
          config.gateway.cooldown.base_seconds = parseInt(config.gateway.cooldown.base_seconds, 10);
        }
        if (typeof config.gateway.cooldown.max_seconds === 'string' && /^\d+$/.test(config.gateway.cooldown.max_seconds)) {
          config.gateway.cooldown.max_seconds = parseInt(config.gateway.cooldown.max_seconds, 10);
        }
      }
    }

    if (Array.isArray(config.clients)) {
      for (const client of config.clients) {
        if (client && client.rate_limit) {
          if (typeof client.rate_limit.window_ms === 'string' && /^\d+$/.test(client.rate_limit.window_ms)) {
            client.rate_limit.window_ms = parseInt(client.rate_limit.window_ms, 10);
          }
          if (typeof client.rate_limit.max === 'string' && /^\d+$/.test(client.rate_limit.max)) {
            client.rate_limit.max = parseInt(client.rate_limit.max, 10);
          }
        }
      }
    }

    if (config.providers && typeof config.providers === 'object') {
      for (const providerConf of Object.values(config.providers)) {
        if (providerConf && Array.isArray(providerConf.models)) {
          for (const model of providerConf.models) {
            if (model && typeof model.default_thinking_budget === 'string' && /^\d+$/.test(model.default_thinking_budget)) {
              model.default_thinking_budget = parseInt(model.default_thinking_budget, 10);
            }
          }
        }
      }
    }
  }

  /**
   * Recursively traverses a configuration node to interpolate env variables.
   * Filters invalid keys (literal empty string, missing env vars, null, undefined) in provider keys.
   */
  interpolate(val, path = []) {
    // If the node is an array, check if it's the "keys" configuration array.
    if (Array.isArray(val)) {
      if (path[path.length - 1] === 'keys') {
        const activeKeys = [];
        const providerName = path[path.length - 2];
        for (let i = 0; i < val.length; i++) {
          const item = val[i];

          // BUG-2: Handle literal empty strings, null, undefined
          if (item === undefined || item === null || (typeof item === 'string' && item.trim() === '')) {
            console.warn(`WARNING: Skipping undefined or empty key for provider '${providerName}' at index ${i}.`);
            continue;
          }

          if (typeof item === 'string') {
            const varRegex = /\$\{([A-Za-z0-9_]+)\}/g;
            const matches = [...item.matchAll(varRegex)];

            if (matches.length > 0) {
              let hasMissing = false;
              let missingVar = '';

              // Validate all environment variables in the key token.
              for (const match of matches) {
                const varName = match[1];
                const envVal = process.env[varName];
                if (envVal === undefined || envVal === null || envVal.trim() === '') {
                  hasMissing = true;
                  missingVar = varName;
                  break;
                }
              }

              if (hasMissing) {
                // Degraded mode: log warning, omit the key, but do not exit yet.
                console.warn(`WARNING: Missing or empty environment variable ${missingVar} for key at path ${path.join('.')}[${i}]. Skipping key.`);
              } else {
                // Replace variable tokens with their corresponding environment values.
                const interpolatedVal = item.replace(varRegex, (m, varName) => process.env[varName]);
                activeKeys.push(interpolatedVal);
              }
            } else {
              // Key is a literal value (no interpolation needed).
              activeKeys.push(item);
            }
          } else {
            activeKeys.push(String(item));
          }
        }
        return activeKeys;
      } else {
        // Recursively process non-keys arrays.
        return val.map((item, index) => this.interpolate(item, [...path, index]));
      }
    }

    // If the node is an object, recursively process all of its keys.
    else if (val && typeof val === 'object') {
      const res = {};
      for (const key of Object.keys(val)) {
        res[key] = this.interpolate(val[key], [...path, key]);
      }
      return res;
    }

    // If the node is a string, perform regex scanning for environment variable tokens.
    else if (typeof val === 'string') {
      const varRegex = /\$\{([A-Za-z0-9_]+)\}/g;
      const matches = [...val.matchAll(varRegex)];

      if (matches.length > 0) {
        let hasMissing = false;
        let missingVar = '';

        for (const match of matches) {
          const varName = match[1];
          const envVal = process.env[varName];
          if (envVal === undefined || envVal === null || envVal.trim() === '') {
            hasMissing = true;
            missingVar = varName;
            break;
          }
        }

        if (hasMissing) {
          // Structural or non-key config variable is missing: throw an error for the caller to handle.
          throw new Error(`Missing or empty environment variable ${missingVar} at configuration path ${path.join('.')}`);
        }

        // Perform token substitution.
        return val.replace(varRegex, (m, varName) => process.env[varName]);
      }
      return val;
    }

    return val;
  }

  /**
   * Starts the fs.watch process on the config file.
   * Handles 'rename' event by closing the old watcher and re-initializing to address atomic saves.
   */
  startWatcher(configPath, reservedProviders = RESERVED_PROVIDERS) {
    if (this.isWatching && !this.watcher) {
      // Re-initializing
    } else if (this.isWatching) {
      return;
    }
    this.isWatching = true;
    this.currentConfigPath = configPath;

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
      } catch (err) {
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
