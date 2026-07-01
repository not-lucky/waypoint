/**
 * @fileoverview Formatter and mapper for Google Gemini API parameters.
 *
 * This module contains formatting utilities for adapting model reasoning configurations
 * and options from the gateway's unified request representation into forms compliant
 * with the Gemini API specs.
 *
 * @module adapters/outbound/gemini/geminiFormatter
 */

/**
 * Maps a standardized reasoning effort tier into the exact thinking level string category
 * supported by specific Gemini models (e.g. Gemini 2.5 Flash vs Gemini 2.0 Pro).
 *
 * The categorization maps:
 * - Pro models: 'minimal'/'low' -> 'low', 'medium' -> 'medium', 'high'/'xhigh'/'max' -> 'high'.
 * - Non-Pro models: 'minimal' -> 'minimal', 'low' -> 'low', 'medium' -> 'medium', 'high'/'xhigh'/'max' -> 'high'.
 *
 * @private
 * @param {string} effort - The reasoning effort tier requested by the user.
 * @param {string} [modelId=''] - The target Gemini model ID used to detect specific limits.
 * @returns {string} The matched Gemini thinking level category (e.g. 'minimal', 'low', 'medium', 'high').
 */
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
 * Resolves the unified request's reasoning effort setting to Gemini's categorical thinking levels.
 *
 * Checks `reasoningEffort` parameters on the request block and translates them using
 * model-aware heuristics to match Gemini-specific thinking levels, defaulting to 'medium'
 * if effort is unspecified.
 *
 * @param {Object} req - The unified incoming request configuration.
 * @param {string} [req.reasoningEffort] - The requested reasoning effort (e.g., 'minimal', 'low', etc.).
 * @param {string} [req.modelid] - The targeted model ID string.
 * @param {string} [req.model] - The alternative model identifier.
 * @returns {string} The corresponding Gemini thinking level string.
 */
export const getThinkingLevel = (req) => {
  const effort = req.reasoningEffort;
  if (effort) {
    return getGeminiThinkingLevel(effort, req.modelid || req.model || '');
  }
  return 'medium';
};

