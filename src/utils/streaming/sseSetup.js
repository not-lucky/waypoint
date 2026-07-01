/**
 * @fileoverview Stream initialization utility for Server-Sent Events (SSE).
 *
 * This module exports helpers to configure HTTP response headers on Express responses,
 * establishing a persistent connection stream and turning off buffering proxies.
 *
 * @module utils/streaming/sseSetup
 */

/**
 * Configures the Express response headers to initiate a Server-Sent Events (SSE) connection stream.
 *
 * Enforces headers including:
 * 1. `Content-Type: text/event-stream` to establish SSE stream.
 * 2. `Cache-Control: no-cache, no-transform` to prevent intermediate caching.
 * 3. `Connection: keep-alive` to sustain persistent connections.
 * 4. `X-Accel-Buffering: no` to instruct reverse proxies (like Nginx) to disable response chunk buffering.
 *
 * @param {import('express').Response} res - The Express HTTP response object to configure.
 * @returns {void}
 */
export function startSSEStream(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
}
