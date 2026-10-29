import { AiProvider } from '../ai/ai-provider.interface';
import { AiQuotaService } from '../ai/ai-quota.service';
import { AiProviderError } from '../ai/ai-provider.error';
import { IconSuggestionService } from './icon-suggestion.service';

function setup(options: {
  available?: boolean;
  remaining?: number;
  assignments?: { name: string; icon: string | null }[];
  fail?: boolean;
}) {
  const extractStructured = jest.fn(() =>
    options.fail
      ? Promise.reject(new AiProviderError('down'))
      : Promise.resolve({
          value: { assignments: options.assignments ?? [] },
          model: 'claude-haiku-4-5',
          inputTokens: 10,
          outputTokens: 5,
          durationMs: 7,
        }),
  );
  const provider = {
    name: 'anthropic',
    isAvailable: () => options.available ?? true,
    extractStructured,
  } as unknown as AiProvider;
  const reserve = jest.fn(() => Promise.resolve({ id: 'usage-1' }));
  const settle = jest.fn(() => Promise.resolve());
  const quota = {
    getQuota: jest.fn(() =>
      Promise.resolve({
        limit: 500,
        used: 0,
        remaining: options.remaining ?? 500,
        resetAt: 'x',
      }),
    ),
    reserve,
    settle,
  } as unknown as AiQuotaService;
  return {
    service: new IconSuggestionService(provider, quota),
    extractStructured,
    reserve,
    settle,
  };
}

describe('IconSuggestionService', () => {
  it('answers lexically without touching the model when every name is clear', async () => {
    const { service, extractStructured } = setup({});
    const result = await service.suggest('org', 'user', ['Pils', 'Radler']);
    expect(result[0].suggestions[0].icon).toBe('pos-icon:pils');
    expect(result[1].suggestions[0].icon).toBe('pos-icon:radler');
    expect(extractStructured).not.toHaveBeenCalled();
  });

  it('asks the model only for unclear names and reserves one unit per name', async () => {
    const { service, extractStructured, reserve, settle } = setup({
      assignments: [
        { name: 'Hauswein', icon: 'wein' },
        { name: 'Kaffee', icon: null },
      ],
    });
    const result = await service.suggest('org', 'user', [
      'Pils',
      'Hauswein',
      'Kaffee',
      'Hauswein',
    ]);
    expect(reserve).toHaveBeenCalledWith('org', 'user', 'icon_suggest', 2);
    expect(extractStructured).toHaveBeenCalledTimes(1);
    const request = extractStructured.mock.calls[0][0] as unknown as {
      text: string;
      purpose: string;
    };
    expect(request.purpose).toBe('classify');
    expect(request.text).toContain('<untrusted source="product-names">');
    expect(result[1].suggestions[0]).toEqual({
      icon: 'pos-icon:wein',
      score: 0.75,
    });
    expect(result[3].suggestions[0]).toEqual({
      icon: 'pos-icon:wein',
      score: 0.75,
    });
    expect(result[2].suggestions).toEqual([]);
    expect(settle).toHaveBeenCalledWith(
      'usage-1',
      expect.objectContaining({ status: 'ok', inputTokens: 10 }),
    );
  });

  it('ignores model answers outside the candidate list', async () => {
    const { service } = setup({
      assignments: [{ name: 'Hauswein', icon: 'pommes' }],
    });
    const result = await service.suggest('org', 'user', ['Hauswein']);
    expect(result[0].suggestions[0]?.icon).not.toBe('pos-icon:pommes');
  });

  it('stays lexical when the provider is off, the quota is short, or the model fails', async () => {
    const off = setup({ available: false });
    await off.service.suggest('org', 'user', ['Hauswein']);
    expect(off.extractStructured).not.toHaveBeenCalled();

    const short = setup({ remaining: 0 });
    await short.service.suggest('org', 'user', ['Hauswein']);
    expect(short.reserve).not.toHaveBeenCalled();

    const failing = setup({ fail: true });
    const result = await failing.service.suggest('org', 'user', ['Hauswein']);
    expect(result[0].name).toBe('Hauswein');
    expect(failing.settle).toHaveBeenCalledWith('usage-1', { status: 'error' });
  });
});
