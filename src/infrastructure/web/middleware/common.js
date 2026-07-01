/**
 * @fileoverview Small, reusable Express middleware helpers.
 *
 * These helpers don't warrant their own modules but are reused in enough
 * places that grouping them keeps `createApp.js` and the controller tests
 * readable.
 */

/**
 * Express middleware that marks the current request as a "dry run".
 *
 * Dry runs short-circuit the adapter pipeline: instead of issuing a real
 * upstream call, the adapter throws a synthetic `isDryRun` error that the
 * controllers catch and turn into a 200 response echoing the would-be
 * request. This is used by the integration test suite to assert that the
 * gateway shapes outgoing payloads correctly without burning upstream quota.
 *
 * The flag is stored on the request object rather than on `res.locals` so
 * downstream code (controllers, orchestrator, adapters) can inspect it
 * through the standard `req.isDryRun` lookup that already exists in
 * `BaseController`.
 *
 * @param {import('express').Request} req - The current Express request.
 * @param {import('express').Response} _res - Express response (unused).
 * @param {import('express').NextFunction} next - Callback to yield control.
 * @returns {void}
 */
export function dryRunMiddleware(req, _res, next) {
  req.isDryRun = true;
  next();
}

/**
 * Detects whether an incoming request should be projected as Anthropic-shaped
 * or OpenAI-shaped downstream.
 *
 * The detection walks `req.baseUrl`, `req.originalUrl`, and `req.path` (any of
 * which may be set depending on whether Express routed through a sub-router)
 * and looks for a `/messages` segment. Hits match Anthropic's path; misses
 * fall through to OpenAI.
 *
 * The query string is stripped before matching so URLs like
 * `/messages?foo=bar` still resolve correctly.
 *
 * @param {import('express').Request | null | undefined} req - The Express request.
 * @returns {'anthropic' | 'openai'} The inferred ingress format.
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