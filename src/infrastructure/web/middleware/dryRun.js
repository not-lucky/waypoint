/** Marks the request as a dry-run so adapters skip upstream calls. */
export function dryRunMiddleware(req, _, next) {
  req.isDryRun = true;
  next();
}
