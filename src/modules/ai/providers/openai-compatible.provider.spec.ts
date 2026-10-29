import OpenAI from 'openai';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';
import { AiProviderError } from '../ai-provider.error';

function fakeClient(overrides: Record<string, unknown> = {}) {
  const create = jest.fn(() =>
    Promise.resolve({
      choices: [
        {
          message: { content: '{"ok":true}', refusal: null },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
      ...overrides,
    } as unknown as OpenAI.Chat.Completions.ChatCompletion),
  );
  return {
    client: { chat: { completions: { create } } } as unknown as Pick<
      OpenAI,
      'chat'
    >,
    create,
  };
}

const schema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
};

describe('OpenAiCompatibleProvider', () => {
  it('is unavailable without a key, never reads PDFs, uses default models', () => {
    expect(new OpenAiCompatibleProvider({ apiKey: '' }).isAvailable()).toBe(
      false,
    );
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'k',
      client: fakeClient().client,
    });
    expect(provider.isAvailable()).toBe(true);
    expect(provider.supportsPdf()).toBe(false);
    expect(provider.modelFor('extract')).toBe('gpt-5');
    expect(provider.modelFor('classify')).toBe('gpt-5-mini');
  });

  it('sends images as data URLs and asks for strict json_schema output', async () => {
    const { client, create } = fakeClient();
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'k',
      client,
      modelExtract: 'my-model',
    });
    const result = await provider.extractStructured<{ ok: boolean }>({
      purpose: 'extract',
      system: 'sys',
      text: 'read this',
      files: [{ mediaType: 'image/jpeg', data: Buffer.from('jpg') }],
      schemaName: 'menu',
      schema,
    });
    expect(result).toMatchObject({
      value: { ok: true },
      model: 'my-model',
      inputTokens: 50,
      outputTokens: 10,
    });
    const params = create.mock
      .calls[0][0] as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParams;
    expect(params.model).toBe('my-model');
    expect(params.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'menu', schema, strict: true },
    });
    expect(params.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(params.messages[1]).toEqual({
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${Buffer.from('jpg').toString('base64')}`,
          },
        },
        { type: 'text', text: 'read this' },
      ],
    });
  });

  it('rejects PDF input with a clear error', async () => {
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'k',
      client: fakeClient().client,
    });
    await expect(
      provider.extractStructured({
        purpose: 'extract',
        system: 's',
        text: 't',
        files: [{ mediaType: 'application/pdf', data: Buffer.from('pdf') }],
        schemaName: 'menu',
        schema,
      }),
    ).rejects.toThrow(/PDF/);
  });

  it('tolerates fenced JSON and maps refusals/length to AiProviderError', async () => {
    const fenced = fakeClient({
      choices: [
        {
          message: { content: '```json\n{"ok":false}\n```', refusal: null },
          finish_reason: 'stop',
        },
      ],
    });
    const value = await new OpenAiCompatibleProvider({
      apiKey: 'k',
      client: fenced.client,
    }).extractStructured<{ ok: boolean }>({
      purpose: 'classify',
      system: 's',
      text: 't',
      schemaName: 'x',
      schema,
    });
    expect(value.value).toEqual({ ok: false });

    const refused = fakeClient({
      choices: [
        { message: { content: null, refusal: 'no' }, finish_reason: 'stop' },
      ],
    });
    await expect(
      new OpenAiCompatibleProvider({
        apiKey: 'k',
        client: refused.client,
      }).complete({ purpose: 'classify', system: 's', text: 't' }),
    ).rejects.toThrow(AiProviderError);

    const cut = fakeClient({
      choices: [
        { message: { content: '{', refusal: null }, finish_reason: 'length' },
      ],
    });
    await expect(
      new OpenAiCompatibleProvider({
        apiKey: 'k',
        client: cut.client,
      }).complete({ purpose: 'classify', system: 's', text: 't' }),
    ).rejects.toThrow(/abgeschnitten/);
  });
});
