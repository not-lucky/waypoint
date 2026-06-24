/**
 * @fileoverview Resolves the ingress protocol format for an Express request.
 *
 * Uses `req.baseUrl` (the router mount path set by `app.use('/anthropic', ...)`) as the
 * primary signal. Falls back to `req.originalUrl` and `req.path` for pre-routing errors
 * (CORS, JSON parser) where `req.baseUrl` is `''`; the fallback still uses
 * `startsWith('/anthropic')`, which is safe in practice since pre-routing errors are
 * protocol-agnostic. Returns `'anthropic'` for any base URL starting with `/anthropic`,
 * otherwise `'openai'`.
 */

/**
 * @param {import('express').Request} req
 * @returns {'anthropic'|'openai'}
 */
export function resolveIngressFormat(req) {
  const baseUrl = req?.baseUrl || req?.originalUrl || req?.path || '';
  return baseUrl.startsWith('/anthropic') ? 'anthropic' : 'openai';
}
