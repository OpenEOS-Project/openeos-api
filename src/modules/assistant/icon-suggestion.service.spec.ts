import { Logger } from '@nestjs/common';
import { AiProvider } from '../ai/ai-provider.interface';
import { AiQuotaService } from '../ai/ai-quota.service';
import { AiProviderError } from '../ai/ai-provider.error';
import { IconSuggestionService } from './icon-suggestion.service';

function setup(options: {
  available?: boolean;
  remaining?: number;
  assignments?: {
    name: string;
    icon: string | null;
    confidence?: 'high' | 'medium' | 'low';
  }[];
  fail?: boolean | Error;
}) {
  const extractStructured = jest.fn(() =>
    options.fail
      ? Promise.reject(
          options.fail instanceof Error
            ? options.fail
            : new AiProviderError('down'),
        )
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
    modelFor: () => 'claude-haiku-4-5',
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
        { name: 'Hauswein', icon: 'wein', confidence: 'high' },
        { name: 'Kaffee', icon: null, confidence: 'high' },
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
      score: 0.6,
      source: 'model',
    });
    expect(result[3].suggestions[0]).toEqual({
      icon: 'pos-icon:wein',
      score: 0.6,
      source: 'model',
    });
    expect(result[2].suggestions).toEqual([]);
    const request0 = extractStructured.mock.calls[0][0] as unknown as {
      system: string;
      schema: {
        properties: { assignments: { items: { required: string[] } } };
      };
    };
    expect(request0.system).toContain('antworte mit icon null');
    expect(request0.schema.properties.assignments.items.required).toContain(
      'confidence',
    );
    expect(settle).toHaveBeenCalledWith(
      'usage-1',
      expect.objectContaining({ status: 'ok', inputTokens: 10 }),
    );
  });

  it('ignores model answers outside the candidate list', async () => {
    // „Sauergespritzter“ trifft lexikalisch halb (weinschorle 0.53): das
    // Modell bekommt nur die zehn besten Kandidaten, Pommes ist keiner.
    const { service, extractStructured } = setup({
      assignments: [
        { name: 'Sauergespritzter', icon: 'pommes', confidence: 'high' },
        { name: 'Hauswein', icon: 'gibt-es-nicht', confidence: 'high' },
      ],
    });
    const result = await service.suggest('org', 'user', [
      'Sauergespritzter',
      'Hauswein',
    ]);
    const request = extractStructured.mock.calls[0][0] as unknown as {
      text: string;
    };
    const items = JSON.parse(
      /<untrusted source="product-names">\n([\s\S]*?)\n<\/untrusted>/.exec(
        request.text,
      )![1],
    ) as { name: string; allowed: string[] | string }[];
    expect(items[0].allowed).toHaveLength(10);
    expect(items[0].allowed).not.toContain('pommes');
    expect(result[0].suggestions[0]?.icon).not.toBe('pos-icon:pommes');
    // Auch aus der Gesamtliste zaehlen nur Icons, die es gibt.
    expect(
      result[1].suggestions.find((match) => match.source === 'model'),
    ).toBeUndefined();
  });

  it('offers every icon once when the best lexical match is weak (Riesling, Export)', async () => {
    const { service, extractStructured } = setup({
      assignments: [
        { name: 'Riesling trocken', icon: 'weisswein', confidence: 'high' },
        { name: 'Export 0,5 l', icon: 'pils', confidence: 'medium' },
      ],
    });
    const result = await service.suggest('org', 'user', [
      'Riesling trocken',
      'Export 0,5 l',
    ]);
    const request = extractStructured.mock.calls[0][0] as unknown as {
      text: string;
      system: string;
    };
    const items = JSON.parse(
      /<untrusted source="product-names">\n([\s\S]*?)\n<\/untrusted>/.exec(
        request.text,
      )![1],
    ) as { name: string; allowed: string[] | string }[];
    expect(items).toEqual([
      { name: 'Riesling trocken', allowed: 'alle' },
      { name: 'Export 0,5 l', allowed: 'alle' },
    ]);
    // Die Gesamtliste steht genau einmal ausserhalb der fremden Daten.
    const listLine = request.text
      .split('\n')
      .find((line) => line.startsWith('Gesamtliste der Icon-IDs: '))!;
    const all = JSON.parse(
      listLine.slice('Gesamtliste der Icon-IDs: '.length),
    ) as string[];
    expect(all).toEqual(service.index.ids());
    expect(all.length).toBeGreaterThan(40);
    expect(request.text.split('Gesamtliste').length).toBe(2);
    expect(request.system).toContain('"alle"');
    expect(result[0].suggestions[0]).toEqual({
      icon: 'pos-icon:weisswein',
      score: 0.6,
      source: 'model',
    });
    expect(result[1].suggestions[0]).toEqual({
      icon: 'pos-icon:pils',
      score: 0.5,
      source: 'model',
    });
  });

  it('keeps "no icon" when the model answers null or is unsure (issue #87)', async () => {
    const { service } = setup({
      assignments: [
        { name: 'Kaffee', icon: null, confidence: 'high' },
        { name: 'Flammkuchen', icon: 'steak-brot', confidence: 'low' },
        { name: 'Kuchen', icon: 'striebele', confidence: 'medium' },
      ],
    });
    const result = await service.suggest('org', 'user', [
      'Kaffee',
      'Flammkuchen',
      'Kuchen',
    ]);
    expect(result[0].suggestions).toEqual([]);
    // low confidence counts as "none": only the weak lexical rest remains
    expect(
      result[1].suggestions.find((match) => match.source === 'model'),
    ).toBeUndefined();
    expect(result[1].suggestions.every((m) => m.score < 0.6)).toBe(true);
    expect(result[2].suggestions[0]).toEqual({
      icon: 'pos-icon:striebele',
      score: 0.5,
      source: 'model',
    });
  });

  it('marks lexical matches with their source and knows brand synonyms', () => {
    const { service } = setup({});
    const [fanta, sprite, pils] = service.suggestLexical([
      'Fanta',
      'Sprite 0,33 l',
      'Pils',
    ]);
    expect(fanta.suggestions[0]).toEqual({
      icon: 'pos-icon:limo-orange',
      score: 1,
      source: 'lexical',
    });
    expect(sprite.suggestions[0].icon).toBe('pos-icon:limo-zitrone');
    expect(pils.suggestions[0].source).toBe('lexical');
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

  it('logs a cut-off answer (reasoning ate the token limit) and keeps the lexical result', async () => {
    const cutOff = setup({
      fail: new AiProviderError(
        'Die Antwort des Modells war zu lang und wurde abgeschnitten (finish=length, 4096/4096 Tokens, davon 4096 Reasoning)',
        undefined,
        false,
        'invalid_output',
      ),
    });
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const lexical = cutOff.service.suggestLexical(['Hauswein']);
      const result = await cutOff.service.suggest('org', 'user', ['Hauswein']);
      expect(result).toEqual(lexical);
      expect(cutOff.settle).toHaveBeenCalledWith('usage-1', {
        status: 'error',
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /fehlgeschlagen.*nur lexikalische.*finish=length/,
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
