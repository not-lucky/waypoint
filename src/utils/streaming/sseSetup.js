/**
 * Shared utility to configure Express response headers for Server-Sent Events (SSE).
 *
 * @param {import('express').Response} res - Express response object.
 * @returns {void}
 */
export function startSSEStream(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
}
