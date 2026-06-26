import { KeyRegistry } from '../../domain/keys/keyRegistry.js';
import { ProviderFactory } from '../../adapters/outbound/factory.js';
import { MetricsCollector } from '../monitoring/metricsCollector.js';
import { UnifiedOrchestrator } from '../../application/orchestrator.js';
import { OpenAIController } from '../../adapters/inbound/openai/index.js';
import { AnthropicController } from '../../adapters/inbound/anthropic/index.js';
import { ModelCache } from '../../domain/routing/cache.js';

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
