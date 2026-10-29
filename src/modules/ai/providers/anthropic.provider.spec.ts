import Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider } from './anthropic.provider';
import { AiProviderError } from '../ai-provider.error';

function fakeClient(response: Partial<Anthropic.Message>) {
  const create = jest.fn(() =>
    Promise.resolve({
      content: [{ type: 'text', text: '{"ok":true}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20 },
      ...response,
    } as Anthropic.Message),
  );
  return {
    client: { messages: { create } } as unknown as Pick<Anthropic, 'messages'>,
    create,
  };
}

const schema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
};

describe('AnthropicProvider', () => {
  it('is unavailable without a key and uses the configured models', () => {
    expect(new AnthropicProvider({ apiKey: '' }).isAvailable()).toBe(false);
    const provider = new AnthropicProvider({
      apiKey: 'k',
      modelExtract: 'claude-x',
      client: fakeClient({}).client,
    });
    expect(provider.isAvailable()).toBe(true);
    expect(provider.supportsPdf()).toBe(true);
    expect(provider.modelFor('extract')).toBe('claude-x');
    expect(provider.modelFor('classify')).toBe('claude-haiku-4-5-20251001');
  });

  it('sends images and PDFs as base64 blocks with a JSON schema output format', async () => {
    const { client, create } = fakeClient({});
    const provider = new AnthropicProvider({ apiKey: 'k', client });
    const result = await provider.extractStructured<{ ok: boolean }>({
      purpose: 'extract',
      system: 'sys',
      text: 'read this',
      files: [
        { mediaType: 'image/png', data: Buffer.from('png') },
        { mediaType: 'application/pdf', data: Buffer.from('pdf') },
      ],
      schemaName: 'test',
      schema,
    });
    expect(result).toEqual({
      value: { ok: true },
      model: 'claude-sonnet-5-5',
      inputTokens: 100,
      outputTokens: 20,
      durationMs: expect.any(Number) as unknown,
    });
    const params = create.mock
      .calls[0][0] as unknown as Anthropic.MessageCreateParams;
    expect(params.model).toBe('claude-sonnet-5-5');
    expect(params.system).toBe('sys');
    expect(params.output_config).toEqual({
      format: { type: 'json_schema', schema },
    });
    const content = params.messages[0].content as Anthropic.ContentBlockParam[];
    expect(content).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from('png').toString('base64'),
        },
      },
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: Buffer.from('pdf').toString('base64'),
        },
      },
      { type: 'text', text: 'read this' },
    ]);
  });

  it('classifies against the allowed choices only', async () => {
    const { client } = fakeClient({
      content: [
        { type: 'text', text: '{"choice":"pils"}' } as Anthropic.TextBlock,
      ],
    });
    const provider = new AnthropicProvider({ apiKey: 'k', client });
    const ok = await provider.classify({
      system: 's',
      text: 't',
      choices: ['pils', 'radler'],
    });
    expect(ok.value).toBe('pils');
    const other = fakeClient({
      content: [
        { type: 'text', text: '{"choice":"cola"}' } as Anthropic.TextBlock,
      ],
    });
    const notAllowed = await new AnthropicProvider({
      apiKey: 'k',
      client: other.client,
    }).classify({
      system: 's',
      text: 't',
      choices: ['pils', 'radler'],
    });
    expect(notAllowed.value).toBeNull();
  });

  it('turns refusals, truncation and API errors into AiProviderError', async () => {
    const refused = fakeClient({ stop_reason: 'refusal' });
    await expect(
      new AnthropicProvider({ apiKey: 'k', client: refused.client }).complete({
        purpose: 'classify',
        system: 's',
        text: 't',
      }),
    ).rejects.toThrow(AiProviderError);

    const truncated = fakeClient({ stop_reason: 'max_tokens' });
    await expect(
      new AnthropicProvider({ apiKey: 'k', client: truncated.client }).complete(
        { purpose: 'classify', system: 's', text: 't' },
      ),
    ).rejects.toThrow(/abgeschnitten/);

    const failing = {
      messages: {
        create: jest.fn(() => Promise.reject(new Error('socket hang up'))),
      },
    } as unknown as Pick<Anthropic, 'messages'>;
    await expect(
      new AnthropicProvider({ apiKey: 'k', client: failing }).complete({
        purpose: 'classify',
        system: 's',
        text: 't',
      }),
    ).rejects.toMatchObject({ name: 'AiProviderError', retryable: true });
  });

  it('rejects answers that are not JSON', async () => {
    const { client } = fakeClient({
      content: [
        {
          type: 'text',
          text: 'Hier ist die Karte: Bier 3 €',
        } as Anthropic.TextBlock,
      ],
    });
    await expect(
      new AnthropicProvider({ apiKey: 'k', client }).extractStructured({
        purpose: 'extract',
        system: 's',
        text: 't',
        schemaName: 'test',
        schema,
      }),
    ).rejects.toThrow(/strukturierte Antwort/);
  });
});
