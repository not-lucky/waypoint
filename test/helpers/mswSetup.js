import { setupServer } from 'msw/node';

export function createMSWServer(...handlers) {
  return setupServer(...handlers);
}
