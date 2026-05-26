/**
 * Utility class to cache and retrieve unique models defined in configurations.
 * Prevents redundant recalculations on every request.
 */
export class ModelCache {
  constructor(config) {
    this.config = config;
    this.cachedUniqueModels = null;
  }

  /**
   * Extracts a deduplicated list of all model IDs and aliases from the configuration.
   *
   * @returns {Array<string>} List of prefixed model identifiers.
   */
  getUniqueModels() {
    if (this.cachedUniqueModels) {
      return this.cachedUniqueModels;
    }

    const providers = this.config?.providers || {};
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

    this.cachedUniqueModels = [...new Set(models)];
    return this.cachedUniqueModels;
  }
}
