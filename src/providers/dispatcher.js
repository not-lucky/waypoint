/**
 * @fileoverview Shared undici dispatcher for upstream provider fetch calls.
 *
 * Node 18+ exposes `fetch` globally, but the underlying undici client does NOT
 * keep idle HTTP connections open between calls by default. Every provider
 * request therefore pays a fresh TCP + TLS handshake (typically 50-150ms on
 * p95 for HTTPS providers like OpenAI, Anthropic, and Gemini).
 *
 * Installing a shared `Agent` with keep-alive as the global dispatcher lets
 * undici pool sockets per origin and reuse them for subsequent requests. This
 * is the documented Node.js pattern for tuning the global fetch behavior
 * (see https://nodejs.org/api/globals.html#fetch).
 *
 * The dispatcher is installed once, very early in `bootstrap()`, before any
 * YAML / logger / service wiring happens. Test paths (`createTestApp`) do not
 * call `bootstrap()`, so MSW's fetch interception is unaffected.
 */

import { Agent, setGlobalDispatcher } from 'undici';

/**
 * Keep-alive idle window in milliseconds. After this period of inactivity the
 * pooled socket is closed gracefully. 30s matches the de-facto upstream default
 * (OpenAI, Anthropic, Gemini all close idle connections around 30-60s).
 * @const {number}
 */
const KEEP_ALIVE_TIMEOUT_MS = 30_000;

/**
 * Hard cap on the keep-alive idle window. Undici forces a fresh handshake if a
 * pooled connection has been idle longer than this, even if the upstream would
 * accept it.
 * @const {number}
 */
const KEEP_ALIVE_MAX_TIMEOUT_MS = 60_000;

/**
 * Per-origin socket pool ceiling. The undici default is 50; we lower it slightly
 * because Waypoint fronts a small fixed set of providers and we don't want
 * unbounded FD growth if a misconfigured provider hosts a wildcard pool.
 * @const {number}
 */
const CONNECTIONS_PER_ORIGIN = 32;

/**
 * Maximum number of pipelined requests on a single socket. 1 is the safe default
 * for streaming LLM endpoints (most providers do not support HTTP pipelining).
 * @const {number}
 */
const PIPELINING = 1;

/** @type {Agent | null} */
let sharedAgent = null;

/**
 * Returns the shared keep-alive Agent, creating it on first access.
 *
 * @returns {Agent}
 */
export function getDispatcherAgent() {
  if (!sharedAgent) {
    sharedAgent = new Agent({
      keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
      keepAliveMaxTimeout: KEEP_ALIVE_MAX_TIMEOUT_MS,
      connections: CONNECTIONS_PER_ORIGIN,
      pipelining: PIPELINING,
    });
  }
  return sharedAgent;
}

/**
 * Installs the shared keep-alive Agent as the global undici dispatcher so the
 * global `fetch` reuses pooled sockets across requests.
 *
 * Safe to call multiple times; subsequent calls re-apply the same shared
 * agent (no new sockets are opened).
 *
 * @returns {Agent} The active dispatcher.
 */
export function installGlobalDispatcher() {
  const agent = getDispatcherAgent();
  setGlobalDispatcher(agent);
  return agent;
}
