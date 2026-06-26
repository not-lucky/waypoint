const getGeminiThinkingLevel = (effort, modelId = '') => {
  const cleanEffort = String(effort || '').toLowerCase();
  const isPro = modelId.includes('pro');

  const knownLevels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (!knownLevels.includes(cleanEffort)) {
    return effort;
  }

  if (isPro) {
    if (cleanEffort === 'minimal' || cleanEffort === 'low') return 'low';
    if (cleanEffort === 'medium') return 'medium';
    if (['high', 'xhigh', 'max'].includes(cleanEffort)) return 'high';
    return 'medium';
  }
  if (cleanEffort === 'minimal') return 'minimal';
  if (cleanEffort === 'low') return 'low';
  if (cleanEffort === 'medium') return 'medium';
  if (['high', 'xhigh', 'max'].includes(cleanEffort)) return 'high';
  return 'medium';
};

/**
 * Resolves unified reasoning effort to Gemini's categorical thinking levels.
 *
 * @param {Object} req - The unified request.
 * @returns {string} Gemini thinking level.
 */
export const getThinkingLevel = (req) => {
  const effort = req.reasoningEffort;
  if (effort) {
    return getGeminiThinkingLevel(effort, req.actualModelId || req.model || '');
  }
  return 'medium';
};
