import fs from 'fs';
import yaml from 'js-yaml';

// Module-level cached configuration state.
// Acts as the live immutable config snapshot.
let currentConfig = null;

// Reference to the active fs.watch instance for config.yaml.
let watcher = null;

// Path of the currently watched/loaded configuration file.
let currentConfigPath = null;

// Watcher state flag to avoid duplicate watchers.
let isWatching = false;

// Registry of listener callbacks invoked when the configuration is hot-reloaded.
const listeners = [];

// Reserved provider names.
// These providers map to official SDKs and do not require a base_url.
const RESERVED_PROVIDERS = new Set(['gemini', 'anthropic', 'openai']);

/**
 * Recursively deep-freezes an object to make it completely immutable.
 * Prevents runtime state corruption and request processing race conditions.
 * 
 * @param {object} obj - Object to deep freeze.
 * @returns {object} The frozen object.
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') {
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
 * Recursively traverses a configuration node to interpolate env variables.
 * Throws an Error (for missing structural variables or tokens) instead of terminating the process.
 * 
 * @param {*} val - Current node value (object, array, string, etc.).
 * @param {string[]} path - Key path from the root config object for precise logging.
 * @returns {*} The interpolated node value.
 */
function interpolate(val, path = []) {
  // If the node is an array, check if it's the "keys" configuration array.
  if (Array.isArray(val)) {
    if (path[path.length - 1] === 'keys') {
      const activeKeys = [];
      for (let i = 0; i < val.length; i++) {
        const item = val[i];
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
          activeKeys.push(item);
        }
      }
      return activeKeys;
    } else {
      // Recursively process non-keys arrays.
      return val.map((item, index) => interpolate(item, [...path, index]));
    }
  } 
  
  // If the node is an object, recursively process all of its keys.
  else if (val && typeof val === 'object') {
    const res = {};
    for (const key of Object.keys(val)) {
      res[key] = interpolate(val[key], [...path, key]);
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
  if (JSON.stringify(oldConf.gateway?.cors) !== JSON.stringify(newConf.gateway?.cors)) return true;
  if (JSON.stringify(oldConf.logging) !== JSON.stringify(newConf.logging)) return true;
  return false;
}

/**
 * Performs configuration validation, validates provider specifications,
 * and handles environment variable interpolation.
 * Throws descriptive validation errors on issues.
 * 
 * @param {object} parsedYaml - Raw configuration object parsed from YAML.
 * @param {Set<string>} [reservedProviders=RESERVED_PROVIDERS] - Set of reserved provider names.
 * @returns {object} Fully validated and interpolated configuration object.
 */
function interpolateAndValidate(parsedYaml, reservedProviders = RESERVED_PROVIDERS) {
  if (!parsedYaml || typeof parsedYaml !== 'object') {
    throw new Error("Invalid configuration structure.");
  }

  // Deep clone to avoid mutating the original parsed object directly before validation.
  const workingConfig = JSON.parse(JSON.stringify(parsedYaml));
  const interpolated = interpolate(workingConfig);

  // Validate that providers are defined.
  if (!interpolated.providers || typeof interpolated.providers !== 'object' || Object.keys(interpolated.providers).length === 0) {
    throw new Error("Configuration must define at least one provider under 'providers'.");
  }

  // Validate properties for each configured provider.
  for (const [providerName, providerConf] of Object.entries(interpolated.providers)) {
    if (!providerConf || typeof providerConf !== 'object') continue;

    // Validate that non-reserved custom providers must define base_url.
    if (!reservedProviders.has(providerName)) {
      if (!providerConf.base_url || typeof providerConf.base_url !== 'string' || providerConf.base_url.trim() === '') {
        throw new Error(`Provider '${providerName}' is a custom provider and must specify a non-empty 'base_url'.`);
      }
    }

    // Validate that the provider pool contains at least one active key.
    if (!providerConf.keys || !Array.isArray(providerConf.keys) || providerConf.keys.length === 0) {
      throw new Error(`Provider '${providerName}' has zero active keys.`);
    }
  }

  return interpolated;
}

/**
 * Starts the fs.watch process on the config file.
 * Automatically parses, validates, and hot-reloads the configuration on changes.
 * Catch validation errors to ensure the server remains online with the last good state.
 * 
 * @param {string} configPath - Path to the YAML configuration file.
 * @param {Set<string>} [reservedProviders=RESERVED_PROVIDERS] - Set of reserved provider names.
 */
function startWatcher(configPath, reservedProviders = RESERVED_PROVIDERS) {
  if (isWatching) return;
  isWatching = true;
  currentConfigPath = configPath;

  let debounceTimeout = null;
  watcher = fs.watch(configPath, (eventType) => {
    // Handle both change and rename (some editors write to temp file then rename).
    if (eventType === 'change' || eventType === 'rename') {
      if (debounceTimeout) clearTimeout(debounceTimeout);
      
      // Debounce filesystem events to prevent race conditions during write cycles.
      debounceTimeout = setTimeout(() => {
        try {
          if (!fs.existsSync(configPath)) {
            return;
          }
          const raw = fs.readFileSync(configPath, 'utf8');
          const parsed = yaml.load(raw);
          const newConfig = deepFreeze(interpolateAndValidate(parsed, reservedProviders));

          // Warn if port or other structural parameters changed.
          const structuralChanged = checkStructuralChanges(currentConfig, newConfig);
          if (structuralChanged) {
            console.warn("WARNING: Structural configuration changed. A process restart is required to apply these changes.");
          }

          // Swap configuration references atomically to prevent request-processing race conditions.
          const oldConfig = currentConfig;
          currentConfig = newConfig;

          // Notify all registered change subscribers.
          for (const listener of listeners) {
            try {
              listener(currentConfig, oldConfig);
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
  });
}

/**
 * Loads the YAML configuration file, parses it, interpolates env variables,
 * and sets up hot-reloading file watch.
 * Fails fast and terminates process if configuration is invalid at startup.
 * 
 * @param {string} [configPath='config/config.yaml'] - Path to configuration file.
 * @param {Set<string>} [reservedProviders=RESERVED_PROVIDERS] - Set of reserved provider names.
 * @returns {object} The live interpolated configuration object reference.
 */
export function loadConfig(configPath = 'config/config.yaml', reservedProviders = RESERVED_PROVIDERS) {
  if (currentConfig) {
    return currentConfig;
  }

  currentConfigPath = configPath;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw);
    currentConfig = deepFreeze(interpolateAndValidate(parsed, reservedProviders));
  } catch (err) {
    // Initial startup validation failure: log fatal error and abort startup.
    console.error(`FATAL ERROR: Failed to load config file at ${configPath}: ${err.message}`);
    process.exit(1);
  }

  startWatcher(configPath, reservedProviders);

  return currentConfig;
}

/**
 * Registers a callback to be triggered when the configuration changes.
 * 
 * @param {function} callback - Callback function receiving (newConfig, oldConfig).
 * @returns {function} Cleanup function to unsubscribe the listener.
 */
export function onConfigChange(callback) {
  listeners.push(callback);
  return () => {
    const idx = listeners.indexOf(callback);
    if (idx !== -1) {
      listeners.splice(idx, 1);
    }
  };
}

/**
 * Stops watching the configuration file and clears any listeners.
 * Part of graceful teardown hooks in Section 8.
 */
export function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  isWatching = false;
  listeners.length = 0;
}

/**
 * Resets the loader module state (primarily used in unit testing to clear cache).
 */
export function resetConfig() {
  stopWatcher();
  currentConfig = null;
  currentConfigPath = null;
}
