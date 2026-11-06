import { ConfigService } from '@nestjs/config';
import {
  createAiProvider,
  AiConfig,
  readAiConfig,
} from './ai-provider.factory';
import { OpenAiCompatibleProvider } from './providers/openai-compatible.provider';

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
  reasoningEffortExtract: '',
  reasoningEffortClassify: '',
  maxImagesPerRequest: 0,
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

  it('passes reasoning effort and the image limit to the openai provider', () => {
    const openai = createAiProvider({
      ...base,
      provider: 'openai',
      openaiApiKey: 'k',
      openaiBaseUrl: 'https://openai.inference.de-txl.ionos.com/v1',
      modelExtract: 'Qwen/Qwen3.8-27B',
      modelClassify: 'Qwen/Qwen3.8-27B',
      reasoningEffortExtract: 'medium',
      reasoningEffortClassify: 'none',
      maxImagesPerRequest: 4,
    }) as OpenAiCompatibleProvider;
    expect(openai.reasoningEffortFor('extract')).toBe('medium');
    expect(openai.reasoningEffortFor('classify')).toBe('none');
    expect(openai.maxImagesPerRequest()).toBe(4);

    const anthropic = createAiProvider({
      ...base,
      provider: 'anthropic',
      anthropicApiKey: 'k',
      reasoningEffortExtract: 'medium',
    });
    expect(anthropic.maxImagesPerRequest()).toBeNull();
  });

  it('reads the new variables from the config and ignores unknown effort values', () => {
    const config = readAiConfig({
      get: () => ({
        provider: 'openai',
        reasoningEffortExtract: 'medium',
        reasoningEffortClassify: 'bogus',
        maxImagesPerRequest: 4,
      }),
    } as unknown as ConfigService);
    expect(config.reasoningEffortExtract).toBe('medium');
    expect(config.reasoningEffortClassify).toBe('');
    expect(config.maxImagesPerRequest).toBe(4);
    expect(
      readAiConfig({ get: () => undefined } as unknown as ConfigService)
        .maxImagesPerRequest,
    ).toBe(0);
  });
});
