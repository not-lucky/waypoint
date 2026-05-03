import fs from 'node:fs';
import yaml from 'js-yaml';
import { isDeepStrictEqual } from 'node:util';
import { getAppLogger } from '../utils/logger.js';

const logtapeLogger = getAppLogger('config');

// Safe wrappers around the dynamic logger to avoid runtime crashes
// if a logger instance goes missing or is not fully initialized.
function logDebug(customLogger, msg, meta) {
  if (customLogger && typeof customLogger.debug === 'function') {
    if (meta !== undefined) customLogger.debug(msg, meta);
    else customLogger.debug(msg);
  } else if (meta !== undefined) logtapeLogger.debug(msg, meta);
  else logtapeLogger.debug(msg);
}

function logWarning(customLogger, msg, meta) {
  if (customLogger) {
    if (typeof customLogger.warning === 'function') {
      if (meta !== undefined) customLogger.warning(msg, meta);
      else customLogger.warning(msg);
    } else if (typeof customLogger.warn === 'function') {
      if (meta !== undefined) customLogger.warn(msg, meta);
      else customLogger.warn(msg);
    }
  } else if (meta !== undefined) logtapeLogger.warning(msg, meta);
  else logtapeLogger.warning(msg);
}

function logError(customLogger, msg, meta) {
  if (customLogger && typeof customLogger.error === 'function') {
    if (meta !== undefined) customLogger.error(msg, meta);
    else customLogger.error(msg);
  } else if (meta !== undefined) logtapeLogger.error(msg, meta);
  else logtapeLogger.error(msg);
}

function logFatal(customLogger, msg, meta) {
  if (customLogger && typeof customLogger.fatal === 'function') {
    if (meta !== undefined) customLogger.fatal(msg, meta);
    else customLogger.fatal(msg);
  } else if (meta !== undefined) logtapeLogger.fatal(msg, meta);
  else logtapeLogger.fatal(msg);
}

// Reserved provider names.
// These providers map to official SDKs and do not require a base_url.
const RESERVED_PROVIDERS = new Set(['gemini', 'anthropic', 'openai']);

// Export node's built-in deep compare as isDeepEqual.
export { isDeepStrictEqual as isDeepEqual };

const VAR_REGEX = /\$\{([A-Za-z0-9_]+)\}/g;

/**
 * Replaces all ${VAR} placeholders in a string with their process.env values.
 * This is crucial for securely injecting API keys via Kubernetes secrets or Docker envs
 * without hardcoding them in the YAML configuration.
 *
 * @param {string} str - The string containing placeholders.
 * @returns {string} The string with all placeholders resolved.
 */
const replaceEnvVars = (str) => str.replace(VAR_REGEX, (_, varName) => process.env[varName]);

/**
 * Scans a string for environment variable placeholders and returns the name of
 * the first one that is missing or empty in the environment.
 * Validates environmental dependencies before attempting connection.
 *
 * @param {string} str - The string to check.
 * @returns {string|null} The name of the missing env var, or null if all exist.
 */
const getMissingEnvVar = (str) => {
  const matches = [...str.matchAll(VAR_REGEX)];
  const missing = matches.find((match) => {
    const envVal = process.env[match[1]];
    // Do not change to `!envVal?.trim()`.
    // In test environments, process.env values are sometimes mocked as numbers or other
    // non-string types. Calling .trim() directly on them will throw a TypeError.
    return envVal === undefined || String(envVal).trim() === '';
  });
  return missing?.[1] ?? null;
};

/**
 * Coerces a specific property of an object to an integer if it's a string of digits.
 * YAML parsers sometimes interpret raw numerical environmental variables as strings,
 * which breaks downstream Zod-style strict integer validators. This safely enforces types.
 *
 * @param {object} obj - The target object.
 * @param {string} key - The property key.
 * @returns {object} A new object with the coerced property, or the original if unchanged.
 */
const coerceToInt = (obj, key) => {
  if (typeof obj?.[key] === 'string' && /^\d+$/.test(obj[key])) {
    return { ...obj, [key]: parseInt(obj[key], 10) };
  }
  return obj;
};

/**
 * Recursively freezes an object making it totally immutable.
 * Used to freeze the loaded configuration to prevent any rogue components from
 * intentionally or accidentally mutating global config state at runtime.
 */
export const deepFreeze = (obj) => {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (obj instanceof Date) {
    const mutators = [
      'setDate', 'setFullYear', 'setHours', 'setMilliseconds', 'setMinutes',
      'setMonth', 'setSeconds', 'setTime', 'setUTCDate', 'setUTCFullYear',
      'setUTCHours', 'setUTCMilliseconds', 'setUTCMinutes', 'setUTCMonth',
      'setUTCSeconds',
    ];
    mutators.forEach((m) => {
      // eslint-disable-next-line no-param-reassign
      obj[m] = () => {
        throw new TypeError('Cannot modify a frozen Date');
      };
    });
    Object.freeze(obj);
    return obj;
  }

  if (obj instanceof Map) {
    const throwFrozen = () => { throw new TypeError('Cannot modify a frozen Map'); };
    // eslint-disable-next-line no-param-reassign
    obj.set = throwFrozen;
    // eslint-disable-next-line no-param-reassign
    obj.delete = throwFrozen;
    // eslint-disable-next-line no-param-reassign
    obj.clear = throwFrozen;
    Object.freeze(obj);
    obj.forEach((val, key) => {
      deepFreeze(key);
      deepFreeze(val);
    });
    return obj;
  }

  if (obj instanceof Set) {
    const throwFrozen = () => { throw new TypeError('Cannot modify a frozen Set'); };
    // eslint-disable-next-line no-param-reassign
    obj.add = throwFrozen;
    // eslint-disable-next-line no-param-reassign
    obj.delete = throwFrozen;
    // eslint-disable-next-line no-param-reassign
    obj.clear = throwFrozen;
    Object.freeze(obj);
    obj.forEach((val) => {
      deepFreeze(val);
    });
    return obj;
  }

  Object.freeze(obj);
  Object.values(obj).forEach((val) => {
    deepFreeze(val);
  });
  return obj;
};

/**
 * Compares critical structural gateway and logging configuration values.
 * Hot-reloading cannot safely apply structural changes like port reassignment or
 * log file rotation without a process restart. This detects those scenarios.
 *
 * @param {object} oldConf - Previous configuration state.
 * @param {object} newConf - New configuration state.
 * @returns {boolean} True if structural fields changed, otherwise false.
 */
const checkStructuralChanges = (oldConf, newConf) => {
  if (!oldConf || !newConf) return false;
  return (
    oldConf.gateway?.port !== newConf.gateway?.port
    || oldConf.gateway?.max_payload_size !== newConf.gateway?.max_payload_size
    || !isDeepStrictEqual(oldConf.gateway?.cors, newConf.gateway?.cors)
    || !isDeepStrictEqual(oldConf.logging, newConf.logging)
  );
};

const logErrorAndExitOrThrow = (msg, shouldExit, customLogger = null) => {
  if (shouldExit) {
    logFatal(customLogger, `FATAL ERROR: ${msg}`);
    process.exit(1);
  }
  throw new Error(msg);
};

const isPositiveInteger = (val) => Number.isInteger(val) && val > 0;

const isNonEmptyString = (val) => typeof val === 'string' && val.trim() !== '';

const matchesModelId = (model, fallbackModelId) => (
  model.id === fallbackModelId
  || (Array.isArray(model.aliases) && model.aliases.includes(fallbackModelId))
);

/**
 * Complex semantic validation for model fallback mappings.
 * Ensures that if model A falls back to model B, model B actually exists and is not
 * model A (preventing infinite recursion loops at route time).
 */
const validateFallbackModel = (
  model,
  modelIndex,
  providerName,
  providers,
  originalProviders,
  shouldExit,
  customLogger = null,
) => {
  const fallbackRef = model.fallback_model;

  if (!isNonEmptyString(fallbackRef)) {
    logErrorAndExitOrThrow(
      `Invalid 'fallback_model' at index ${modelIndex} for provider '${providerName}'. Must be a non-empty string.`,
      shouldExit,
      customLogger,
    );
  }

  const [fallbackProvider, fallbackModelId, ...rest] = fallbackRef.split('/');
  if (!fallbackProvider?.trim() || !fallbackModelId?.trim() || rest.length > 0) {
    logErrorAndExitOrThrow(
      `Invalid 'fallback_model' format '${fallbackRef}' at index ${modelIndex} for provider '${providerName}'. Must be in 'provider/model-id' format.`,
      shouldExit,
      customLogger,
    );
  }

  const targetProvider = providers[fallbackProvider];
  if (!targetProvider) {
    if (originalProviders.has(fallbackProvider)) {
      return true;
    }
    logErrorAndExitOrThrow(
      `Invalid 'fallback_model' reference '${fallbackRef}' at index ${modelIndex} for provider '${providerName}': provider '${fallbackProvider}' does not exist in configuration.`,
      shouldExit,
      customLogger,
    );
  }

  const hasMatchingModel = Array.isArray(targetProvider.models)
    && targetProvider.models.some((m) => matchesModelId(m, fallbackModelId));
  if (!hasMatchingModel) {
    logErrorAndExitOrThrow(
      `Invalid 'fallback_model' reference '${fallbackRef}' at index ${modelIndex} for provider '${providerName}': model ID or alias '${fallbackModelId}' does not exist in provider '${fallbackProvider}'.`,
      shouldExit,
      customLogger,
    );
  }

  if (fallbackProvider === providerName && matchesModelId(model, fallbackModelId)) {
    logErrorAndExitOrThrow(
      `Invalid 'fallback_model' reference '${fallbackRef}' at index ${modelIndex} for provider '${providerName}': model cannot fall back to itself.`,
      shouldExit,
      customLogger,
    );
  }

  return false;
};

/**
 * Exhaustive structural validation against the loaded YAML config.
 * Fails fast by design. An invalid configuration shouldn't run, as it could
 * silently misroute requests or expose unintended permissions.
 */
export const validateConfig = (
  config,
  shouldExit = true,
  reservedProviders = RESERVED_PROVIDERS,
  customLogger = null,
) => {
  if (!config) {
    logErrorAndExitOrThrow('Configuration object is null or undefined.', shouldExit, customLogger);
  }

  if (!config.gateway || typeof config.gateway !== 'object') {
    logErrorAndExitOrThrow("Missing structural field 'gateway'.", shouldExit, customLogger);
  }

  if (!isPositiveInteger(config.gateway.port)) {
    logErrorAndExitOrThrow("Missing or invalid 'gateway.port'. Must be a positive integer.", shouldExit, customLogger);
  }

  if (config.gateway.global_retry_limit !== undefined
    && !isPositiveInteger(config.gateway.global_retry_limit)) {
    logErrorAndExitOrThrow("Invalid 'gateway.global_retry_limit'. Must be a positive integer.", shouldExit, customLogger);
  }

  if (config.gateway.http_timeout_ms !== undefined
    && !isPositiveInteger(config.gateway.http_timeout_ms)) {
    logErrorAndExitOrThrow("Invalid 'gateway.http_timeout_ms'. Must be a positive integer.", shouldExit, customLogger);
  }

  if (config.gateway.cooldown !== undefined) {
    if (typeof config.gateway.cooldown !== 'object' || config.gateway.cooldown === null) {
      logErrorAndExitOrThrow("Invalid 'gateway.cooldown'. Must be an object.", shouldExit, customLogger);
    }

    const { base_seconds: baseSeconds, max_seconds: maxSeconds } = config.gateway.cooldown;
    if (baseSeconds !== undefined && !isPositiveInteger(baseSeconds)) {
      logErrorAndExitOrThrow("Invalid 'gateway.cooldown.base_seconds'. Must be a positive integer.", shouldExit, customLogger);
    }
    if (maxSeconds !== undefined && !isPositiveInteger(maxSeconds)) {
      logErrorAndExitOrThrow("Invalid 'gateway.cooldown.max_seconds'. Must be a positive integer.", shouldExit, customLogger);
    }
  }

  if (config.gateway.routing !== undefined) {
    if (typeof config.gateway.routing !== 'object' || config.gateway.routing === null) {
      logErrorAndExitOrThrow("Invalid structural field 'gateway.routing'. Must be an object.", shouldExit, customLogger);
    }
    const { strategy } = config.gateway.routing;
    if (strategy !== undefined && strategy !== 'round-robin' && strategy !== 'fill-first') {
      logErrorAndExitOrThrow(
        `Invalid routing strategy '${strategy}'. Supported strategies: 'round-robin', 'fill-first'.`,
        shouldExit,
        customLogger,
      );
    }
  }

  if (!config.clients || !Array.isArray(config.clients)) {
    logErrorAndExitOrThrow("Missing structural field 'clients'.", shouldExit, customLogger);
  }

  config.clients.forEach((client, i) => {
    if (!client || typeof client !== 'object') {
      logErrorAndExitOrThrow(`Invalid client configuration at index ${i}.`, shouldExit, customLogger);
    }
    if (!isNonEmptyString(client.token)) {
      logErrorAndExitOrThrow(`Missing or empty 'token' for client at index ${i}.`, shouldExit, customLogger);
    }
    if (!client.rate_limit || typeof client.rate_limit !== 'object') {
      logErrorAndExitOrThrow(`Missing structural field 'rate_limit' for client at index ${i}.`, shouldExit, customLogger);
    }
    if (!isPositiveInteger(client.rate_limit.window_ms)) {
      logErrorAndExitOrThrow(
        `Invalid or missing 'rate_limit.window_ms' for client at index ${i}. Must be a positive integer.`,
        shouldExit,
        customLogger,
      );
    }
    if (!isPositiveInteger(client.rate_limit.max)) {
      logErrorAndExitOrThrow(
        `Invalid or missing 'rate_limit.max' for client at index ${i}. Must be a positive integer.`,
        shouldExit,
        customLogger,
      );
    }
  });

  if (!config.logging || typeof config.logging !== 'object') {
    logErrorAndExitOrThrow("Missing structural field 'logging'.", shouldExit, customLogger);
  }
  if (typeof config.logging.enable_console !== 'boolean') {
    logErrorAndExitOrThrow("Invalid or missing 'logging.enable_console'. Must be a boolean.", shouldExit, customLogger);
  }
  if (typeof config.logging.enable_file !== 'boolean') {
    logErrorAndExitOrThrow("Invalid or missing 'logging.enable_file'. Must be a boolean.", shouldExit, customLogger);
  }
  if (config.logging.enable_file && !isNonEmptyString(config.logging.file_path)) {
    logErrorAndExitOrThrow("Invalid or missing 'logging.file_path'. Must be a non-empty string.", shouldExit, customLogger);
  }
  if (config.logging.format !== 'json' && config.logging.format !== 'text') {
    logErrorAndExitOrThrow("Invalid or missing 'logging.format'. Must be 'json' or 'text'.", shouldExit, customLogger);
  }

  const validLevels = ['debug', 'info', 'warning', 'error', 'fatal'];
  if (config.logging.level !== undefined && !validLevels.includes(config.logging.level)) {
    logErrorAndExitOrThrow(
      `Invalid 'logging.level' value '${config.logging.level}'. Must be one of: ${validLevels.join(', ')}.`,
      shouldExit,
      customLogger,
    );
  }

  if (
    !config.providers
    || typeof config.providers !== 'object'
    || Object.keys(config.providers).length === 0
  ) {
    logErrorAndExitOrThrow("Configuration must define at least one provider under 'providers'.", shouldExit, customLogger);
  }

  const originalProviders = new Set(Object.keys(config.providers));

  Object.entries(config.providers).forEach(([providerName, providerConf]) => {
    if (!providerConf || typeof providerConf !== 'object') {
      logErrorAndExitOrThrow(`Invalid configuration for provider '${providerName}'.`, shouldExit, customLogger);
    }

    // --- type field validation ---
    // Reserved providers must never carry a type field; it is ignored with a warning.
    if (reservedProviders.has(providerName)) {
      if (providerConf.type !== undefined) {
        const msg = `WARNING: Reserved provider '${providerName}' does not accept a 'type' field. It will be ignored.`;
        logWarning(customLogger, msg);
        // eslint-disable-next-line no-param-reassign
        delete providerConf.type;
      }
    } else {
      // Custom providers: validate type if present, default to 'openai-compatible' if omitted.
      const VALID_TYPES = ['openai-compatible', 'anthropic-compatible'];
      if (providerConf.type === undefined) {
        // eslint-disable-next-line no-param-reassign
        providerConf.type = 'openai-compatible';
      } else if (!VALID_TYPES.includes(providerConf.type)) {
        logErrorAndExitOrThrow(
          `Invalid 'type' value '${providerConf.type}' for custom provider '${providerName}'. unknown provider type.`,
          shouldExit,
          customLogger,
        );
      }
    }

    if (!reservedProviders.has(providerName) && !isNonEmptyString(providerConf.base_url)) {
      logErrorAndExitOrThrow(
        `Provider '${providerName}' is a custom provider and must specify a non-empty 'base_url'. custom provider requires base_url.`,
        shouldExit,
        customLogger,
      );
    }

    if (Array.isArray(providerConf.keys)) {
      const originalLength = providerConf.keys.length;
      const validKeys = providerConf.keys.filter((key, index) => {
        if (key == null || (typeof key === 'string' && key.trim() === '')) {
          const msg = `WARNING: Skipping undefined or empty key for provider '${providerName}' at index ${index}.`;
          logWarning(customLogger, msg);
          return false;
        }
        return true;
      });
      if (validKeys.length !== originalLength && !Object.isFrozen(providerConf)) {
        // eslint-disable-next-line no-param-reassign
        providerConf.keys = validKeys;
      }
    }

    if (!Array.isArray(providerConf.keys) || providerConf.keys.length === 0) {
      logErrorAndExitOrThrow(
        `Provider '${providerName}' has zero active keys remaining in the pool.`,
        shouldExit,
        customLogger,
      );
      return;
    }

    if (!providerConf.models || !Array.isArray(providerConf.models)
      || providerConf.models.length === 0) {
      logErrorAndExitOrThrow(`Provider '${providerName}' must have a non-empty 'models' array.`, shouldExit, customLogger);
    }

    providerConf.models.forEach((model, j) => {
      if (!model || typeof model !== 'object') {
        logErrorAndExitOrThrow(`Invalid model at index ${j} for provider '${providerName}'.`, shouldExit, customLogger);
      }
      if (!isNonEmptyString(model.id)) {
        logErrorAndExitOrThrow(`Missing or empty model 'id' at index ${j} for provider '${providerName}'.`, shouldExit, customLogger);
      }
      if (model.aliases !== undefined && !Array.isArray(model.aliases)) {
        logErrorAndExitOrThrow(
          `Invalid 'aliases' at index ${j} for provider '${providerName}'. Must be an array.`,
          shouldExit,
          customLogger,
        );
      }
      if (model.thinking_supported !== undefined && typeof model.thinking_supported !== 'boolean') {
        logErrorAndExitOrThrow(
          `Invalid 'thinking_supported' at index ${j} for provider '${providerName}'. Must be a boolean.`,
          shouldExit,
          customLogger,
        );
      }
      if (
        model.default_thinking_budget !== undefined
        && !isPositiveInteger(model.default_thinking_budget)
      ) {
        logErrorAndExitOrThrow(
          `Invalid 'default_thinking_budget' at index ${j} for provider '${providerName}'. Must be a positive integer.`,
          shouldExit,
          customLogger,
        );
      }

      if (model.fallback_model !== undefined) {
        validateFallbackModel(
          model,
          j,
          providerName,
          config.providers,
          originalProviders,
          shouldExit,
          customLogger,
        );
      }
    });
  });

  logDebug(customLogger, 'Configuration validation passed successfully');
};

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
    this.logger = null;
  }

  /**
   * Injects the logger instance after initial config load.
   */
  setLogger(logger) {
    this.logger = logger;
  }

  /**
   * Loads the YAML configuration file, parses it, interpolates env variables,
   * and sets up hot-reloading file watch.
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

    this.startWatcher(configPath, reservedProviders);

    return this.currentConfig;
  }

  /**
   * Registers a callback to be triggered when the configuration changes.
   */
  onConfigChange(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((listener) => listener !== callback);
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
      throw new Error('Invalid configuration structure.');
    }

    // Deep clone to avoid mutating the original parsed object directly before validation.
    const workingConfig = structuredClone(parsedYaml);
    const interpolated = this.interpolate(workingConfig);

    // Coerce numeric properties immutably
    const coerced = ConfigLoader.coerceNumericProperties(interpolated);

    // Call validateConfig with shouldExit = false so hot reloads gracefully
    // fail on invalid configs.
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
          (g) => coerceToInt(g, 'global_retry_limit'),
          (g) => coerceToInt(g, 'http_timeout_ms'),
          (g) => (g.cooldown ? {
            ...g,
            cooldown: coerceToInt(coerceToInt(g.cooldown, 'base_seconds'), 'max_seconds'),
          } : g),
        ].reduce((acc, fn) => fn(acc), config.gateway),
      }),
      ...(Array.isArray(config.clients) && {
        clients: config.clients.map((client) => (client?.rate_limit ? {
          ...client,
          rate_limit: coerceToInt(coerceToInt(client.rate_limit, 'window_ms'), 'max'),
        } : client)),
      }),
      ...(config.providers && typeof config.providers === 'object' && {
        providers: Object.fromEntries(
          Object.entries(config.providers).map(([name, providerConf]) => [
            name,
            {
              ...providerConf,
              ...(Array.isArray(providerConf?.models) && {
                models: providerConf.models.map((model) => coerceToInt(model, 'default_thinking_budget')),
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

  /**
   * Starts the fs.watch process on the config file.
   * Handles 'rename' event by closing the old watcher and re-initializing to address atomic saves
   * (e.g. vim/nano replacing the inode).
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
        logDebug(this.logger, `Starting config file watcher for: ${configPath}`);
        this.watcher = fs.watch(configPath, (eventType) => {
          logDebug(this.logger, `Config file watcher detected event '${eventType}' on: ${configPath}`);
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
        retryCount += 1;
        if (retryCount >= 5) {
          const msg = 'WARNING: Stopped watching configuration file after 5 failed attempts.';
          logWarning(this.logger, msg);
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

        // Warn if port or other structural parameters changed since we can't hot reload those.
        const structuralChanged = checkStructuralChanges(this.currentConfig, newConfig);
        if (structuralChanged) {
          const msg = 'WARNING: Structural configuration changed. A process restart is required to apply these changes.';
          logWarning(this.logger, msg);
        }

        // Swap configuration references atomically to prevent request-processing race conditions.
        const oldConfig = this.currentConfig;
        this.currentConfig = newConfig;

        // Notify all registered change subscribers.
        this.listeners.forEach((listener) => {
          try {
            listener(this.currentConfig, oldConfig);
          } catch (err) {
            logError(this.logger, 'Error in config change listener:', err);
          }
        });
      } catch (err) {
        // At runtime, we catch validation errors and keep the server process online.
        const msg = `Error reloading configuration file on change: ${err.message}`;
        logError(this.logger, msg);
      }
    }, 100);
  }
}
