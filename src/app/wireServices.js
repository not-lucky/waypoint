import { KeyRegistry } from '../registry/keyManagement/registryCore.js';
import { ProviderFactory } from '../adapters/providerFactory.js';
import { UnifiedOrchestrator } from '../services/unifiedOrchestrator.js';
import { OpenAIController } from '../controllers/openaiController.js';
import { AnthropicController } from '../controllers/anthropicController.js';
import { ModelCache } from '../domain/modelCache.js';

export function wireServices(config, logger) {
  const keyRegistry = new KeyRegistry(config);
  const providerFactory = new ProviderFactory(config);
  const orchestrator = new UnifiedOrchestrator(keyRegistry, providerFactory, config, logger);
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
  };
}
