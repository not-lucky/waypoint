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

/**
 * WHAT: Parses and extracts <thought> tags from raw content.
 * WHY: Cleans up reasoning vs final answer separation if thinking content is mixed in text content.
 *
 * @param {string} contentText - Raw text content from the choices.
 * @param {string|null} reasoning - Existing reasoning content, if any.
 * @returns {Object} Cleaned content and separate reasoning content.
 */
export function extractThoughtTags(contentText, reasoning) {
  let content = contentText;
  let reasoningContent = reasoning;

  // Search for the opening <thought> tag to see if reasoning has been mixed into the text delta
  const startIdx = content.indexOf('<thought>');
  if (startIdx !== -1) {
    const endIdx = content.indexOf('</thought>', startIdx + 9);
    if (endIdx !== -1) {
      // The tag is fully enclosed in the chunk; slice it out cleanly.
      const extractedThinking = content.slice(startIdx + 9, endIdx);
      if (!reasoningContent) {
        reasoningContent = extractedThinking;
      }
      content = content.slice(0, startIdx) + content.slice(endIdx + 10);
    } else {
      // The tag is partially opened but not closed; slice everything after the start index.
      const extractedThinking = content.slice(startIdx + 9);
      if (!reasoningContent) {
        reasoningContent = extractedThinking;
      }
      content = content.slice(0, startIdx);
    }
  }

  return { content, reasoningContent };
}
