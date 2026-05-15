import { isDeepStrictEqual } from 'node:util';

/**
 * Safely compares two values for deep equality.
 * Re-exports the Node.js native deep strict equality helper.
 */
export { isDeepStrictEqual as isDeepEqual };

/**
 * Recursively freezes an object making it totally immutable.
 * Used to freeze the loaded configuration to prevent any rogue components from
 * intentionally or accidentally mutating global config state at runtime.
 */
export const deepFreeze = (obj) => {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (obj instanceof Date) {
    const mutators = [
      'setDate', 'setFullYear', 'setHours', 'setMilliseconds', 'setMinutes',
      'setMonth', 'setSeconds', 'setTime', 'setUTCDate', 'setUTCFullYear',
      'setUTCHours', 'setUTCMilliseconds', 'setUTCMinutes', 'setUTCMonth',
      'setUTCSeconds',
    ];
    mutators.forEach((m) => {
      // eslint-disable-next-line no-param-reassign
      obj[m] = () => {
        throw new TypeError('Cannot modify a frozen Date');
      };
    });
    Object.freeze(obj);
    return obj;
  }

  if (obj instanceof Map) {
    const throwFrozen = () => { throw new TypeError('Cannot modify a frozen Map'); };
    // eslint-disable-next-line no-param-reassign
    obj.set = throwFrozen;
    // eslint-disable-next-line no-param-reassign
    obj.delete = throwFrozen;
    // eslint-disable-next-line no-param-reassign
    obj.clear = throwFrozen;
    Object.freeze(obj);
    obj.forEach((val, key) => {
      deepFreeze(key);
      deepFreeze(val);
    });
    return obj;
  }

  if (obj instanceof Set) {
    const throwFrozen = () => { throw new TypeError('Cannot modify a frozen Set'); };
    // eslint-disable-next-line no-param-reassign
    obj.add = throwFrozen;
    // eslint-disable-next-line no-param-reassign
    obj.delete = throwFrozen;
    // eslint-disable-next-line no-param-reassign
    obj.clear = throwFrozen;
    Object.freeze(obj);
    obj.forEach((val) => {
      deepFreeze(val);
    });
    return obj;
  }

  Object.freeze(obj);
  Object.values(obj).forEach((val) => {
    deepFreeze(val);
  });
  return obj;
};
