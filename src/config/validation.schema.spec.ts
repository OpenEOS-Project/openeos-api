/*
 * Optionale Assistent-Variablen kommen aus docker-compose als `${VAR:-}`,
 * also als leerer String. Der muss wie "nicht gesetzt" durchgehen, sonst
 * startet die API nicht ("is not allowed to be empty").
 */
import { validationSchema } from './validation.schema';
import {
  createAiProvider,
  readAiConfig,
} from '../modules/ai/ai-provider.factory';
import { OPENAI_DEFAULT_MODELS } from '../modules/ai/providers/openai-compatible.provider';
import { ConfigService } from '@nestjs/config';

const EMPTY_AI_ENV = {
  JWT_SECRET: 'test-secret',
  OPENAI_BASE_URL: '',
  AI_MODEL_EXTRACT: '',
  AI_MODEL_CLASSIFY: '',
};

function validate(env: Record<string, string>) {
  return validationSchema.validate(env, { allowUnknown: true }) as {
    error?: Error;
    value: Record<string, string>;
  };
}

function loadAiConfig(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  for (const key of [
    'OPENAI_BASE_URL',
    'AI_MODEL_EXTRACT',
    'AI_MODEL_CLASSIFY',
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    let ai: Record<string, unknown> | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./configuration') as {
        default: () => { ai: Record<string, unknown> };
      };
      ai = mod.default().ai;
    });
    return ai!;
  } finally {
    process.env = saved;
  }
}

describe('validationSchema: empty optional assistant variables', () => {
  it('accepts empty strings for OPENAI_BASE_URL and AI_MODEL_*', () => {
    const { error, value } = validate(EMPTY_AI_ENV);
    expect(error).toBeUndefined();
    expect(value.OPENAI_BASE_URL).toBe('');
    expect(value.AI_MODEL_EXTRACT).toBe('');
    expect(value.AI_MODEL_CLASSIFY).toBe('');
  });

  it('still rejects a non-URL base URL', () => {
    const { error } = validate({
      ...EMPTY_AI_ENV,
      OPENAI_BASE_URL: 'not a url',
    });
    expect(error).toBeDefined();
  });

  it('falls back to the defaults when the values are empty', () => {
    const ai = loadAiConfig(EMPTY_AI_ENV);
    expect(ai.openaiBaseUrl).toBe('https://api.openai.com/v1');
    expect(ai.modelExtract).toBe('');
    expect(ai.modelClassify).toBe('');

    const configService = {
      get: () => ({ ...ai, provider: 'openai', openaiApiKey: 'k' }),
    } as unknown as ConfigService;
    const provider = createAiProvider(readAiConfig(configService));
    expect(provider.name).toBe('openai');
    expect(provider.modelFor('extract')).toBe(OPENAI_DEFAULT_MODELS.extract);
    expect(provider.modelFor('classify')).toBe(OPENAI_DEFAULT_MODELS.classify);
  });
});
