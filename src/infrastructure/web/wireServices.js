/**
 * @fileoverview Service dependency wiring.
 *
 * Centralizes the construction order for every long-lived service
 * instance so the bootstrap sequence in `server.js` remains declarative.
 * Tests typically call `wireServices(testConfig)` directly to spin up
 * an end-to-end harness without touching the network.
 */

import { KeyRegistry } from '../../domain/keys/keyRegistry.js';
import { ProviderFactory } from '../../adapters/outbound/factory.js';
import { MetricsCollector } from '../monitoring/metricsCollector.js';
import { UnifiedOrchestrator } from '../../application/orchestrator.js';
import { OpenAIController } from '../../adapters/inbound/openai/index.js';
import { AnthropicController } from '../../adapters/inbound/anthropic/index.js';
import { ModelCache } from '../../domain/routing/cache.js';

/**
 * Constructs the full service graph from a validated configuration.
 *
 * Construction order is significant:
 *
 * 1. `MetricsCollector` — created first so the key registry can
 *    increment cooldown counters as keys fail.
 * 2. `KeyRegistry` — receives the metrics collector and the validated
 *    provider configurations, building one `KeyPool` per provider.
 * 3. `ProviderFactory` — instantiates outbound adapters (OpenAI,
 *    Gemini, Anthropic, Cloudflare) by walking the registered strategies
 *    against the providers map.
 * 4. `UnifiedOrchestrator` — depends on the key registry and provider
 *    factory; it is the central request dispatcher.
 * 5. `OpenAIController` / `AnthropicController` — depend on the orchestrator.
 * 6. `ModelCache` — wraps the provider list to serve `/models` responses.
 *
 * @param {Object} config - The validated application configuration object.
 * @returns {{
 *   keyRegistry: import('../../domain/keys/keyRegistry.js').KeyRegistry,
 *   providerFactory: import('../../adapters/outbound/factory.js').ProviderFactory,
 *   orchestrator: import('../../application/orchestrator.js').UnifiedOrchestrator,
 *   openAIController: import('../../adapters/inbound/openai/index.js').OpenAIController,
 *   anthropicController: import('../../adapters/inbound/anthropic/index.js').AnthropicController,
 *   modelCache: import('../../domain/routing/cache.js').ModelCache,
 *   metricsCollector: import('../monitoring/metricsCollector.js').MetricsCollector,
 * }} The wired service graph.
 */
export function wireServices(config) {
  const metricsCollector = new MetricsCollector();
  const keyRegistry = new KeyRegistry(config, null, metricsCollector);
  const providerFactory = new ProviderFactory(config);
  const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config);
  const openAIController = new OpenAIController(orchestrator);
  const anthropicController = new AnthropicController(orchestrator);
  const modelCache = new ModelCache(config);

  return {
    keyRegistry,
    providerFactory,
    orchestrator,
    openAIController,
    anthropicController,
    modelCache,
    metricsCollector,
  };
}
