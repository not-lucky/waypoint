/**
 * Finds the longest suffix of a string (`str`) that matches a prefix of another string (`target`).
 * This is useful during stream parsing to detect and handle tags that may be split across multiple
 * stream chunk boundaries (e.g., `<thought>` or `</thought>`).
 *
 * @param {string} str - The source string whose suffix is checked.
 * @param {string} target - The target string whose prefix is checked.
 * @returns {string} The overlapping substring, or an empty string if no overlap is found.
 */
export function getLongestPrefixSuffix(str, target) {
  const maxLen = Math.min(str.length, target.length - 1);
  for (let len = maxLen; len > 0; len -= 1) {
    const suffix = str.slice(-len);
    if (target.startsWith(suffix)) {
      return suffix;
    }
  }
  return '';
}
