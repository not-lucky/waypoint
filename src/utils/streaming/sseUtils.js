/**
 * Sets standard SSE headers on an Express response before streaming begins.
 *
 * @param {import('express').Response} res - Express response object.
 */
export function startSSEStream(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
}
