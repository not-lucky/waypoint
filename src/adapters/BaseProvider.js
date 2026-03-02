/* eslint-disable max-classes-per-file, class-methods-use-this */

export class NotImplementedError extends Error {
  constructor(message = 'Not implemented') {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export class BaseProvider {
  async generateCompletion() {
    throw new NotImplementedError();
  }

  async generateStream() {
    throw new NotImplementedError();
  }

  normalizeError() {
    throw new NotImplementedError();
  }
}

export default BaseProvider;
