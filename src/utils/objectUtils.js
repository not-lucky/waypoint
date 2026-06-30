/**
 * @fileoverview Shared object-related utilities.
 */

/**
 * Returns true if the value is a non-null, non-array object (i.e. a "plain" object
 * suitable for recursive merging, deep cloning, or key enumeration).
 *
 * @param {*} value - The value to test.
 * @returns {boolean} True when value is a plain object.
 */
export const isPlainObject = (value) => (
  Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)
);