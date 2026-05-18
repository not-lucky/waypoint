export const THINKING_BUDGETS = { low: 512, medium: 2048, high: 8192 };

/**
 * Creates a new, immutable UnifiedRequest context from the base request payload,
 * configuration, and headers, avoiding side effects or mutations.
 *
 * @param {Object} baseReq - The base request payload.
 * @param {Object} rawReq - The raw Express request.
 * @param {Object} resolved - The resolved model metadata from ModelRouter.
 * @returns {{ unifiedReq: Object, cleanRawReq: Object }}
 */
export const transformRequest = (baseReq, rawReq, resolved) => {
  const headers = rawReq?.headers || {};

  let provider;
  let actualModelId;
  let fallbackModel;
  let thinkingSupported;
  let thinkingEnabled;
  let thinkingBudget;

  if (resolved) {
    const { modelConfig } = resolved;
    provider = resolved.provider;
    actualModelId = modelConfig.id;

    if (modelConfig.fallback_model) {
      fallbackModel = modelConfig.fallback_model;
    }

    if (modelConfig.thinking_supported) {
      thinkingSupported = true;
      thinkingEnabled = true;
      if (modelConfig.default_thinking_budget !== undefined) {
        thinkingBudget = modelConfig.default_thinking_budget;
      }
    }
  }

  // Apply header-based overrides (thinking level, temperature)
  const thinkingLevel = headers['x-gateway-thinking-level'];
  if (thinkingLevel) {
    const budget = THINKING_BUDGETS[thinkingLevel.toLowerCase()];
    if (budget !== undefined) {
      thinkingBudget = budget;
      thinkingEnabled = true;
    }
  }

  const tempHeader = headers['x-gateway-temperature'];
  let { temperature } = baseReq;
  if (tempHeader !== undefined) {
    const parsed = parseFloat(tempHeader);
    if (!Number.isNaN(parsed) && parsed >= 0.0 && parsed <= 2.0) {
      temperature = parsed;
    }
  }

  const unifiedReq = {
    ...baseReq,
    provider,
    actualModelId,
    ...(fallbackModel ? { fallbackModel } : {}),
    ...(thinkingSupported ? { thinking_supported: true } : {}),
    ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
    ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
    temperature,
  };

  const sanitizedHeaders = { ...headers };
  delete sanitizedHeaders['x-gateway-thinking-level'];
  delete sanitizedHeaders['x-gateway-temperature'];

  const cleanRawReq = Object.create(rawReq || {});
  cleanRawReq.headers = sanitizedHeaders;

  return { unifiedReq, cleanRawReq };
};
