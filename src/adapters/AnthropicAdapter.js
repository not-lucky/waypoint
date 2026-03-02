import { BaseProvider } from './BaseProvider.js';

export class AnthropicAdapter extends BaseProvider {
  constructor(baseUrl) {
    super();
    this.baseUrl = baseUrl;
  }
}

export default AnthropicAdapter;
