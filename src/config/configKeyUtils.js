/**
 * Filters invalid keys (null, undefined, empty strings) from a key array.
 * Logs warnings for skipped keys.
 *
 * @param {Array<any>} keys - The raw keys array.
 * @param {string} providerName - Provider name for log messages.
 * @param {Object} logger - Logger instance with a warning method.
 * @param {Function} [getCandidate=(key) => key] - Optional selector for the value to validate.
 * @returns {Array<any>} Filtered valid keys.
 */
export function filterValidKeys( keys, providerName, logger, getCandidate = ( key ) => key ) {
  return keys.filter( ( key, index ) => {
    const candidate = getCandidate( key )

    if ( candidate == null || ( typeof candidate === 'string' && candidate.trim() === '' ) ) {
      logger.warning(
        `WARNING: Skipping undefined or empty key for provider '${ providerName }' at index ${ index }.`,
      )
      return false
    }

    return true
  } )
}
