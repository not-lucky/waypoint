import fs from 'node:fs';
import yaml from 'js-yaml';
import { deepFreeze, isDeepEqual } from '../utils/objectUtils.js';
import {
  logDebug,
  logWarning,
  logError,
  logFatal,
} from './loggerWrapper.js';
import {
  RESERVED_PROVIDERS,
  replaceEnvVars,
  getMissingEnvVar,
  coerceToInt,
  checkStructuralChanges,
} from './utils.js';
import { validateConfig } from './validator.js';

export { deepFreeze, isDeepEqual, validateConfig };

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
                models: providerConf.models.map((model) => {
                  let m = { ...model };
                  m = coerceToInt(m, 'max_tokens');
                  m = coerceToInt(m, 'maxTokens');
                  if (m.overrides && typeof m.overrides === 'object') {
                    let o = m.overrides;
                    o = coerceToInt(o, 'max_tokens');
                    o = coerceToInt(o, 'maxTokens');
                    m = { ...m, overrides: o };
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
