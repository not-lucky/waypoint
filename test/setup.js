import { afterEach, beforeAll } from 'vitest';
import { resetLifecycleState } from '../src/lifecycle/lifecycle.js';

beforeAll(() => {
  // Prevent MaxListenersExceededWarning caused by LogTape and other services
  // binding exit/SIGINT/SIGTERM handlers across multiple parallel/sequential test runs.
  process.setMaxListeners(30);
});

afterEach(() => {
  resetLifecycleState();
});
