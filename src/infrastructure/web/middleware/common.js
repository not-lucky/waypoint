/**
 * @fileoverview Common middleware utilities.
 * Contains small middleware functions that don't warrant separate files.
 */

/**
 * Marks the request as a dry-run so adapters skip upstream calls.
 */
export function dryRunMiddleware(req, _, next) {
  req.isDryRun = true;
  next();
}

/**
 * Resolves the ingress protocol format for an Express request.
 *
 * Checks `req.baseUrl`, `req.originalUrl`, and `req.path`. If any of these paths contain
 * `/messages` or end with `/messages`, classifies the request as `'anthropic'`.
 * Otherwise, defaults to `'openai'`.
 *
 * @param {import('express').Request} req
 * @returns {'anthropic'|'openai'}
 */
export function resolveIngressFormat(req) {
  if (!req) return 'openai';
  const paths = [req.baseUrl, req.originalUrl, req.path]
    .filter(Boolean)
    .map((p) => p.split('?')[0]);
  for (const p of paths) {
    if (/(^|\/)messages(\/|$)/.test(p)) {
      return 'anthropic';
    }
  }
  return 'openai';
}
