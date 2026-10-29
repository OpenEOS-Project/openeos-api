import { createAiProvider, AiConfig } from './ai-provider.factory';

const base: AiConfig = {
  provider: 'none',
  anthropicApiKey: '',
  openaiApiKey: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  modelExtract: '',
  modelClassify: '',
  menuImportsPerDay: 5,
  menuPagesPerImport: 6,
  classifyPerDay: 500,
  maxUploadMb: 10,
};

describe('createAiProvider', () => {
  it('returns the NoneProvider by default', () => {
    const provider = createAiProvider(base);
    expect(provider.name).toBe('none');
    expect(provider.isAvailable()).toBe(false);
  });

  it('builds anthropic/openai providers and reports missing keys as unavailable', () => {
    expect(
      createAiProvider({ ...base, provider: 'anthropic' }).isAvailable(),
    ).toBe(false);
    const anthropic = createAiProvider({
      ...base,
      provider: 'anthropic',
      anthropicApiKey: 'k',
      modelExtract: 'm',
    });
    expect(anthropic.name).toBe('anthropic');
    expect(anthropic.isAvailable()).toBe(true);
    expect(anthropic.modelFor('extract')).toBe('m');

    const openai = createAiProvider({
      ...base,
      provider: 'openai',
      openaiApiKey: 'k',
    });
    expect(openai.name).toBe('openai');
    expect(openai.isAvailable()).toBe(true);
    expect(openai.supportsPdf()).toBe(false);
  });
});
