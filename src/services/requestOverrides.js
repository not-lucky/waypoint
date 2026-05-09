/**
 * WHAT: Parses and applies client-supplied gateway header overrides to the unified request.
 * WHY: Allows per-request configuration overrides (like thinking level or temperature)
 * without altering the static global provider configurations.
 *
 * @param {Object} req - The unified request payload to mutate.
 * @param {Object} rawReq - The raw incoming Express request.
 */
export function applyRequestOverrides(req, rawReq) {
  if (!rawReq?.headers) {
    return;
  }

  // Check for the custom x-gateway-thinking-level header (e.g. 'low', 'medium', 'high')
  const thinkingLevelHeader = rawReq.headers['x-gateway-thinking-level'];
  if (thinkingLevelHeader) {
    const level = thinkingLevelHeader.toLowerCase();
    // eslint-disable-next-line no-param-reassign
    req.thinkingLevel = level;
    // eslint-disable-next-line no-param-reassign
    req.thinkingEnabled = true;

    // Map the categorical level to standard token budget bounds if not explicitly overridden
    const budgets = { low: 1024, medium: 2048, high: 4096 };
    if (req.thinkingBudget === undefined && budgets[level]) {
      // eslint-disable-next-line no-param-reassign
      req.thinkingBudget = budgets[level];
    }
  }

  // Check for the custom x-gateway-temperature header to override default generation temperature
  const tempHeader = rawReq.headers['x-gateway-temperature'];
  if (tempHeader) {
    const parsedTemp = parseFloat(tempHeader);
    if (!Number.isNaN(parsedTemp)) {
      // eslint-disable-next-line no-param-reassign
      req.temperature = parsedTemp;
    }
  }
}
