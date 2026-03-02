import { BaseProvider } from './BaseProvider.js';

export class OpenAICompatibleAdapter extends BaseProvider {
  constructor(baseUrl, providerName) {
    super();
    this.baseUrl = baseUrl;
    this.providerName = providerName;
  }
}

export default OpenAICompatibleAdapter;
