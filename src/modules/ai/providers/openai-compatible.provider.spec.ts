import OpenAI from 'openai';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';
import { Logger } from '@nestjs/common';
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

  it('rejects raw PDF input (pages must arrive as images) with a clear error', async () => {
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

  it('sends reasoning_effort per purpose and leaves it out when not configured', async () => {
    const { client, create } = fakeClient();
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'k',
      client,
      reasoningEffort: { extract: 'medium', classify: 'none' },
    });
    await provider.extractStructured({
      purpose: 'extract',
      system: 's',
      text: 't',
      schemaName: 'x',
      schema,
    });
    await provider.classify({ system: 's', text: 't', choices: ['a'] });
    await provider.complete({ purpose: 'classify', system: 's', text: 't' });
    const sent = create.mock.calls.map(
      (call) =>
        (
          call as unknown[]
        )[0] as OpenAI.Chat.Completions.ChatCompletionCreateParams,
    );
    expect(sent.map((params) => params.reasoning_effort)).toEqual([
      'medium',
      'none',
      'none',
    ]);
    expect(provider.reasoningEffortFor('extract')).toBe('medium');

    const plain = fakeClient();
    await new OpenAiCompatibleProvider({
      apiKey: 'k',
      client: plain.client,
      reasoningEffort: { extract: '', classify: undefined },
    }).extractStructured({
      purpose: 'extract',
      system: 's',
      text: 't',
      schemaName: 'x',
      schema,
    });
    expect(
      Object.keys(
        (plain.create.mock.calls[0] as unknown[])[0] as Record<string, unknown>,
      ),
    ).not.toContain('reasoning_effort');
  });

  it('puts reasoning_effort and the page images into the HTTP request body', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = jest.fn((_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'c1',
            object: 'chat.completion',
            created: 0,
            model: 'Qwen/Qwen3.8-27B',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '{"ok":true}' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: 'https://inference.example.test/v1',
      fetch: fetch as unknown as typeof globalThis.fetch,
      maxRetries: 0,
    });
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'test-key',
      client,
      modelExtract: 'Qwen/Qwen3.8-27B',
      reasoningEffort: { extract: 'medium' },
      maxImagesPerRequest: 4,
    });
    const result = await provider.extractStructured<{ ok: boolean }>({
      purpose: 'extract',
      system: 's',
      text: 't',
      files: [
        { mediaType: 'image/jpeg', data: Buffer.from('p1') },
        { mediaType: 'image/jpeg', data: Buffer.from('p2') },
      ],
      schemaName: 'menu',
      schema,
    });
    expect(result.value).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as unknown[])[0]).toBe(
      'https://inference.example.test/v1/chat/completions',
    );
    expect(bodies[0]).toMatchObject({
      model: 'Qwen/Qwen3.8-27B',
      reasoning_effort: 'medium',
      max_completion_tokens: 16000,
    });
    const content = (
      bodies[0].messages as { content: { type: string }[] | string }[]
    )[1].content as { type: string }[];
    expect(content.map((part) => part.type)).toEqual([
      'image_url',
      'image_url',
      'text',
    ]);
  });

  it('refuses more images than AI_MAX_IMAGES_PER_REQUEST before calling the service', async () => {
    const { client, create } = fakeClient();
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'k',
      client,
      maxImagesPerRequest: 4,
    });
    expect(provider.maxImagesPerRequest()).toBe(4);
    const image = { mediaType: 'image/png' as const, data: Buffer.from('x') };
    await expect(
      provider.extractStructured({
        purpose: 'extract',
        system: 's',
        text: 't',
        files: [image, image, image, image, image],
        schemaName: 'menu',
        schema,
      }),
    ).rejects.toThrow(/Zu viele Bilder.*5.*4/);
    expect(create).not.toHaveBeenCalled();
    expect(
      new OpenAiCompatibleProvider({
        apiKey: 'k',
        client,
      }).maxImagesPerRequest(),
    ).toBeNull();
  });

  it('logs a warning with finish reason and reasoning tokens when reasoning eats the limit', async () => {
    const cut = fakeClient({
      choices: [
        { message: { content: '', refusal: null }, finish_reason: 'length' },
      ],
      usage: {
        prompt_tokens: 1462,
        completion_tokens: 4096,
        completion_tokens_details: { reasoning_tokens: 4096 },
      },
    });
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const error = (await new OpenAiCompatibleProvider({
        apiKey: 'k',
        client: cut.client,
        modelClassify: 'Qwen/Qwen3.8-27B',
      })
        .extractStructured({
          purpose: 'classify',
          system: 's',
          text: 't',
          schemaName: 'x',
          schema,
          maxOutputTokens: 4096,
        })
        .catch((e: unknown) => e)) as AiProviderError;
      expect(error).toBeInstanceOf(AiProviderError);
      expect(error.kind).toBe('invalid_output');
      expect(error.message).toMatch(
        /finish=length, 4096\/4096 Tokens, davon 4096 Reasoning/,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /Qwen\/Qwen3\.8-27B \(classify\).*finish=length.*AI_REASONING_EFFORT_CLASSIFY senken \(z\. B\. none\)/,
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
