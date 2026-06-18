import { KeyRegistry } from '../registry/keyRegistry.js';
import { ProviderFactory } from '../providers/factory.js';
import { MetricsCollector } from '../monitoring/metricsCollector.js';
import { UnifiedOrchestrator } from '../services/unifiedOrchestrator.js';
import { OpenAIController } from '../controllers/openaiController.js';
import { AnthropicController } from '../controllers/anthropicController.js';
import { ModelCache } from '../domain/modelCache.js';

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
