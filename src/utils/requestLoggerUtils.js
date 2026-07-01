/**
 * @fileoverview Utility functions for request loggers and auditing infrastructure.
 *
 * This module provides helper routines for generating random IDs, formatting
 * filesystem-safe timestamps, writing diagnostic JSON files asynchronously,
 * sanitizing query parameters (such as API keys) from URLs, and serializing or
 * redacting sensitive HTTP headers.
 *
 * @module utils/requestLoggerUtils
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';

/**
 * Generates a short, cryptographically secure random ID suitable for naming request log folders.
 *
 * Uses `crypto.randomBytes` to generate 3 random bytes and encodes them as a 6-character
 * lowercase hexadecimal string.
 *
 * @returns {string} A fixed 6-character lowercase hex string.
 */
export const shortId = () => crypto.randomBytes(3).toString('hex');

/**
 * Converts an ISO timestamp to a filesystem-safe string.
 * Replaces colons with dashes (e.g., "2026-06-06T10-19-30.123Z") so logs can be
 * exported natively to Windows disks.
 * @param {string} iso - ISO 8601 timestamp.
 * @returns {string} Filesystem-safe timestamp.
 */
export const safeTimestamp = (iso) => iso.replace(/:/g, '-');

/**
 * Writes JSON data to a file asynchronously.
 * Offloads heavy JSON serialization and IO waiting from the main thread event loop.
 * @param {string} filePath - Absolute path to write to.
 * @param {*} data - Data to JSON-stringify and write.
 * @param {Object} [logger=console] - Logger instance for error reporting.
 */
export const writeJsonFile = async (filePath, data, logger = console) => {
  try {
    await fsp.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch (err) {
    logger.error('Failed to write request log file', { filePath, error: err.message });
  }
};

/**
 * Safely sanitizes a URL by removing sensitive credential parameters (e.g. key).
 * Prevents credentials from leaking into debugging logs or file storage.
 * @param {string} urlString - Raw URL string.
 * @returns {string} Sanitized URL string.
 */
export const sanitizeUrl = (urlString) => {
  if (!urlString || typeof urlString !== 'string') return '';
  if (URL.canParse(urlString)) {
    const url = new URL(urlString);
    url.searchParams.delete('key');
    return url.toString();
  }
  // Try dummy base for relative paths starting with /
  if (urlString.startsWith('/') && URL.canParse(urlString, 'http://dummy.com')) {
    const url = new URL(urlString, 'http://dummy.com');
    url.searchParams.delete('key');
    return url.pathname + url.search + url.hash;
  }
  // Fallback for other malformed/relative URLs using a safe fixed regex
  let sanitized = urlString.replace(/[?&]key=[^&]*/g, '');
  if (urlString.includes('?') && !sanitized.includes('?') && sanitized.includes('&')) {
    sanitized = sanitized.replace('&', '?');
  }
  return sanitized;
};

/**
 * Serializes standard Headers object (from fetch Response) to a standard object.
 * Resolves incompatibilities between native Fetch Headers representation and standard JSON format.
 * @param {Headers|Object} headers - The Headers object or plain object.
 * @returns {Object} Plain object representing headers.
 */
export const serializeHeaders = (headers) => {
  if (!headers) return {};
  if (typeof headers.forEach === 'function') {
    const obj = {};
    headers.forEach((v, k) => {
      obj[k] = v;
    });
    return obj;
  }
  if (typeof headers.entries === 'function') {
    return Object.fromEntries(headers.entries());
  }
  return { ...headers };
};

/**
 * Redacts sensitive headers from a headers object.
 * Masks authorization, x-api-key, and similar auth headers to adhere to basic
 * PII and credential safety standards.
 * @param {Object} headers - Raw HTTP headers.
 * @returns {Object} Copy with sensitive values replaced by "[REDACTED]".
 */
export const redactHeaders = (headers) => {
  if (!headers || typeof headers !== 'object') return {};
  const redacted = {};
  const sensitiveKeys = ['authorization', 'x-api-key', 'proxy-authorization'];
  Object.entries(headers).forEach(([key, val]) => {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.includes(lowerKey)) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = val;
    }
  });
  return redacted;
};
