/**
 * @fileoverview Shared object-related utility functions.
 *
 * This module provides basic utility functions for inspecting, mutating,
 * and working with JavaScript Object instances.
 *
 * @module utils/objectUtils
 */

/**
 * Returns true if the value is a non-null, non-array object (i.e. a "plain" object
 * suitable for recursive merging, deep cloning, or key enumeration).
 *
 * Checks that the value is truthy, has a type of 'object', and is not a native Array.
 *
 * @param {*} value - The value under inspection to test.
 * @returns {boolean} True when value is a plain object, false otherwise.
 */
export const isPlainObject = (value) => (
  Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)
);