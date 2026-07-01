/**
 * Attaches the raw upstream JSON body to a mapped response as a non-enumerable
 * `_rawResponse` property.
 *
 * Why this exists:
 * - `RequestLog.logProviderResponse` prefers `response._rawResponse` when
 *   present, so the `03_provider_response.json` debug artefact contains the
 *   provider-native shape (candidates / content blocks / OpenAI choices) that
 *   the operator actually saw on the wire, not the post-translation shape.
 * - The property is declared `enumerable: false` so it never leaks into
 *   `JSON.stringify(response)` going to the HTTP client, and is invisible to
 *   `Object.keys` / spread / destructuring on the public response.
 * - It is `configurable: true` and `writable: true` so tests can override it
 *   and so the adapter contract can evolve without breaking consumers.
 *
 * @param {Object} mapped - The translated response returned by the adapter.
 * @param {Object} raw - The raw JSON body returned by the upstream provider.
 * @returns {void}
 */
export const attachRawResponse = (mapped, raw) => {
  Object.defineProperty(mapped, '_rawResponse', {
    value: raw,
    writable: true,
    enumerable: false,
    configurable: true,
  });
};
