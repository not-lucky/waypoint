import fsp from 'node:fs/promises';
import { getAppLogger } from './logger.js';

const logger = getAppLogger('request-logger');

/**
 * Safely sanitizes a URL by removing sensitive credential parameters (e.g. key).
 * Prevents credentials from leaking into debugging logs or file storage.
 * @param {string} urlString - Raw URL string.
 * @returns {string} Sanitized URL string.
 */
export const sanitizeUrl = (urlString) => {
  if (!urlString || typeof urlString !== 'string') return '';
  try {
    const url = new URL(urlString);
    url.searchParams.delete('key');
    return url.toString();
  } catch (e) {
    return urlString.replace(/[?&]key=[^&]*/g, '');
  }
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
 * Generates a short random ID for request folder naming.
 * Provides a unique collision-free directory footprint for concurrent logged requests.
 * @returns {string} 6-character hex string.
 */
export const shortId = () => Math.random().toString(16).slice(2, 8);

/**
 * Converts an ISO timestamp to a filesystem-safe string.
 * Replaces colons with dashes (e.g., "2026-06-06T10-19-30.123Z") so logs can be
 * exported natively to Windows disks.
 * @param {string} iso - ISO 8601 timestamp.
 * @returns {string} Filesystem-safe timestamp.
 */
export const safeTimestamp = (iso) => iso.replace(/:/g, '-');

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

/**
 * Writes JSON data to a file asynchronously.
 * Offloads heavy JSON serialization and IO waiting from the main thread event loop.
 * @param {string} filePath - Absolute path to write to.
 * @param {*} data - Data to JSON-stringify and write.
 */
export const writeJsonFile = async (filePath, data) => {
  try {
    await fsp.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch (err) {
    logger.error('Failed to write request log file', { filePath, error: err.message });
  }
};
