import { describe, it, expect } from 'vitest';
import { deepFreeze, isDeepEqual, ConfigLoader } from '../src/config/loader.js';

describe('Critique Fixes Verification', () => {
  describe('deepFreeze with Map, Set, and Date', () => {
    it('should freeze Date and throw TypeError on modification', () => {
      const d = new Date(1718928374000);
      deepFreeze(d);
      expect(Object.isFrozen(d)).toBe(true);
      expect(() => d.setTime(0)).toThrow(TypeError);
    });

    it('should freeze Map and throw TypeError on modification', () => {
      const m = new Map([['key1', 'value1']]);
      deepFreeze(m);
      expect(Object.isFrozen(m)).toBe(true);
      expect(() => m.set('key2', 'value2')).toThrow(TypeError);
      expect(() => m.delete('key1')).toThrow(TypeError);
      expect(() => m.clear()).toThrow(TypeError);
    });

    it('should freeze Set and throw TypeError on modification', () => {
      const s = new Set(['item1']);
      deepFreeze(s);
      expect(Object.isFrozen(s)).toBe(true);
      expect(() => s.add('item2')).toThrow(TypeError);
      expect(() => s.delete('item1')).toThrow(TypeError);
      expect(() => s.clear()).toThrow(TypeError);
    });

    it('should recursively freeze nested Maps, Sets, and Dates', () => {
      const nested = {
        map: new Map([['a', 1]]),
        set: new Set([2]),
        date: new Date()
      };
      deepFreeze(nested);
      expect(Object.isFrozen(nested.map)).toBe(true);
      expect(Object.isFrozen(nested.set)).toBe(true);
      expect(Object.isFrozen(nested.date)).toBe(true);
      expect(() => nested.map.set('b', 2)).toThrow(TypeError);
      expect(() => nested.set.add(3)).toThrow(TypeError);
      expect(() => nested.date.setTime(0)).toThrow(TypeError);
    });
  });

  describe('isDeepEqual recursive checks', () => {
    it('should return true for identical objects with different key ordering', () => {
      const objA = { x: 1, y: { z: 2, w: 3 } };
      const objB = { y: { w: 3, z: 2 }, x: 1 };
      expect(isDeepEqual(objA, objB)).toBe(true);
    });

    it('should return false for different structures', () => {
      const objA = { x: 1, y: 2 };
      const objB = { x: 1, y: 3 };
      expect(isDeepEqual(objA, objB)).toBe(false);
    });

    it('should support Date, Map, and Set comparisons', () => {
      const dateA = new Date(1000);
      const dateB = new Date(1000);
      const dateC = new Date(2000);
      expect(isDeepEqual(dateA, dateB)).toBe(true);
      expect(isDeepEqual(dateA, dateC)).toBe(false);

      const mapA = new Map([['a', { x: 1 }]]);
      const mapB = new Map([['a', { x: 1 }]]);
      const mapC = new Map([['a', { x: 2 }]]);
      expect(isDeepEqual(mapA, mapB)).toBe(true);
      expect(isDeepEqual(mapA, mapC)).toBe(false);

      const setA = new Set([1, 2]);
      const setB = new Set([2, 1]);
      const setC = new Set([1, 3]);
      expect(isDeepEqual(setA, setB)).toBe(true);
      expect(isDeepEqual(setA, setC)).toBe(false);
    });
  });

  describe('Parallel ConfigLoaders isolation', () => {
    it('should allow multiple ConfigLoader instances to manage state independently', () => {
      const loader1 = new ConfigLoader();
      const loader2 = new ConfigLoader();

      expect(loader1.currentConfig).toBeNull();
      expect(loader2.currentConfig).toBeNull();

      loader1.currentConfig = { val: 1 };
      loader2.currentConfig = { val: 2 };

      expect(loader1.currentConfig.val).toBe(1);
      expect(loader2.currentConfig.val).toBe(2);

      const cb1 = () => {};
      const cb2 = () => {};

      loader1.onConfigChange(cb1);
      loader2.onConfigChange(cb2);

      expect(loader1.listeners).toContain(cb1);
      expect(loader1.listeners).not.toContain(cb2);
      expect(loader2.listeners).toContain(cb2);
      expect(loader2.listeners).not.toContain(cb1);
    });
  });
});
