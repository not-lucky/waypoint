// Helper to verify if a value is a standard JSON-like object (i.e. not null, not an array).
// This prevents us from attempting to merge arrays or primitives recursively.
import { isPlainObject } from '../../../utils/objectUtils.js';

// Target containers that are known nested parameter structures for providers:
// - 'extra_body': Gemini (under Generative Language OpenAI compatibility) uses this for
//   features like google_search. It also holds the gateway-injected 'thinking_config' for
//   reasoning models. Deep-merging ensures the gateway config and client params coexist.
// - 'metadata': Anthropic APIs accept client-specified metadata, which must merge cleanly.
const deepMergeKeys = new Set(['extra_body', 'metadata']);

// Recursively merges plain object properties from source to target.
// Mutates target in-place to avoid breaking references in calling adapters.
const deepMerge = (target, source) => {
  for (const key of Object.keys(source)) {
    if (isPlainObject(target[key]) && isPlainObject(source[key])) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
};

/**
 * Merges extraBody request parameters into the outgoing provider-specific payload.
 *
 * For known nested containers (like 'extra_body' or 'metadata'), it performs a recursive
 * deep merge to prevent overwriting adapter-level defaults (e.g. Gemini thinking_config)
 * with client-supplied parameters (e.g. google_search).
 *
 * For all other top-level keys, it performs a standard shallow merge to preserve
 * expected behavior (e.g., overriding provider configurations entirely).
 *
 * @param {Object} payload - The provider-specific payload to augment.
 * @param {Object|undefined} extraBody - Extra fields to merge.
 * @returns {Object} The mutated payload.
 */
export const applyExtraBody = (payload, extraBody) => {
  if (!isPlainObject(extraBody)) {
    return payload;
  }

  for (const key of Object.keys(extraBody)) {
    // If the key is a registered nested container and both payload and extraBody
    // have plain object values for it, perform a recursive deep merge.
    if (deepMergeKeys.has(key) && isPlainObject(payload[key]) && isPlainObject(extraBody[key])) {
      deepMerge(payload[key], extraBody[key]);
    } else {
      // Otherwise, perform a shallow assignment, overwriting the payload value.
      payload[key] = extraBody[key];
    }
  }

  return payload;
};
