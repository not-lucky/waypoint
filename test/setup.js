import { afterEach } from 'vitest';
import { resetLifecycleState } from '../src/lifecycle.js';

afterEach(() => {
  resetLifecycleState();
});
