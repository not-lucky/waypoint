/**
 * Utility class to cache and retrieve unique models defined in configurations.
 * Prevents redundant recalculations on every request.
 */
export class ModelCache {
  constructor(configLoader) {
    this.configLoader = configLoader;
    this.cachedUniqueModels = null;
    this.lastConfig = null;
  }

  /**
   * Extracts a deduplicated list of all model IDs and aliases from the current configuration.
   * Caches the list keyed on the configuration object reference.
   *
   * @returns {Array<string>} List of prefixed model identifiers.
   */
  getUniqueModels() {
    const currentConfig = this.configLoader.loadConfig();
    if (this.cachedUniqueModels && this.lastConfig === currentConfig) {
      return this.cachedUniqueModels;
    }

    const providers = currentConfig.providers || {};
    const models = Object.entries(providers).flatMap(([providerName, providerConfig]) => {
      const providerModels = providerConfig.models || [];
      return providerModels.flatMap((modelConfig) => {
        const list = [];
        if (modelConfig.id) list.push(`${providerName}/${modelConfig.id}`);
        if (Array.isArray(modelConfig.aliases)) {
          list.push(...modelConfig.aliases.map((alias) => `${providerName}/${alias}`));
        }
        return list;
      });
    });

    this.lastConfig = currentConfig;
    this.cachedUniqueModels = [...new Set(models)];
    return this.cachedUniqueModels;
  }
}
