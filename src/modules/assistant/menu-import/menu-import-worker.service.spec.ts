import { ConfigService } from '@nestjs/config';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Repository } from 'typeorm';
import {
  Category,
  MenuImport,
  Organization,
  Product,
} from '../../../database/entities';
import { CronLockService } from '../../../common/redis/cron-lock.service';
import { GatewayService } from '../../gateway/gateway.service';
import { AiProvider } from '../../ai/ai-provider.interface';
import { AiQuotaService } from '../../ai/ai-quota.service';
import { AiProviderError } from '../../ai/ai-provider.error';
import { AiInputFilesService } from '../../ai/ai-input-files.service';
import { PdfRasterizer, PdfReadError } from '../../ai/pdf-rasterizer';
import { MENU_IMPORT_PDF_UNREADABLE_TEXT } from './menu-import-errors';
import { IconSuggestionService } from '../icon-suggestion.service';
import { importDir, storeFiles } from './menu-import-files';
import { MenuImportWorkerService } from './menu-import-worker.service';

const FIXTURES = join(__dirname, '../../../../test/fixtures/menu');
const ORG = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';
const EVENT = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

type Stored = MenuImport & { id: string };

function setup(options: {
  extraction?: unknown;
  /** Je Aufruf eine eigene Antwort (Aufteilung nach Bildgrenze). */
  extractions?: unknown[];
  fail?: Error;
  supportsPdf?: boolean;
  maxImages?: number | null;
  rasterizer?: PdfRasterizer;
}) {
  const uploadDir = mkdtempSync(join(tmpdir(), 'menu-worker-'));
  const imports = new Map<string, Stored>();
  const updates: [unknown, Partial<MenuImport>][] = [];
  const builder = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };
  let claimTarget: { id: string; status: string } | null = null;
  builder.where.mockImplementation(
    (_sql: string, params: { id: string; status: string }) => {
      claimTarget = params;
      return builder;
    },
  );
  builder.execute.mockImplementation(() => {
    const target = claimTarget ? imports.get(claimTarget.id) : undefined;
    if (!target || target.status !== claimTarget?.status)
      return Promise.resolve({ affected: 0 });
    target.status = 'processing';
    return Promise.resolve({ affected: 1 });
  });
  const deleteImport = jest.fn(() => Promise.resolve());
  const importRepository = {
    createQueryBuilder: jest.fn(() => builder),
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        imports.get(where.id) ? structuredClone(imports.get(where.id)) : null,
      ),
    ),
    update: jest.fn((where: { id: string }, values: Partial<MenuImport>) => {
      updates.push([where, values]);
      const stored = imports.get(where.id);
      if (stored) Object.assign(stored, values);
      return Promise.resolve();
    }),
    find: jest.fn(() => Promise.resolve([])),
    delete: deleteImport,
  } as unknown as Repository<MenuImport>;
  let call = 0;
  const extractStructured = jest.fn(() =>
    options.fail
      ? Promise.reject(options.fail)
      : Promise.resolve({
          value: options.extractions
            ? options.extractions[call++]
            : options.extraction,
          model: 'claude-sonnet-5-5',
          inputTokens: 900,
          outputTokens: 250,
          durationMs: 3000,
        }),
  );
  const provider = {
    name: 'anthropic',
    isAvailable: () => false,
    supportsPdf: () => options.supportsPdf ?? true,
    maxImagesPerRequest: () => options.maxImages ?? null,
    extractStructured,
  } as unknown as AiProvider;
  const inputFiles = new AiInputFilesService(
    provider,
    options.rasterizer ??
      new PdfRasterizer({
        exec: () => Promise.reject(new Error('pdftoppm not expected')),
      }),
  );
  const settle = jest.fn(() => Promise.resolve());
  const quota = {
    settle,
    getQuota: jest.fn(),
    reserve: jest.fn(),
  } as unknown as AiQuotaService;
  const notify = jest.fn();
  const gateway = {
    notifyMenuImportUpdated: notify,
  } as unknown as GatewayService;
  const cronLock = {
    runExclusive: jest.fn((_name: string, job: () => Promise<void>) =>
      job().then(() => true),
    ),
  } as unknown as CronLockService;
  const service = new MenuImportWorkerService(
    importRepository,
    {
      find: jest.fn(() => Promise.resolve([])),
    } as unknown as Repository<Category>,
    {
      find: jest.fn(() => Promise.resolve([{ id: 'prod-pils', name: 'Pils' }])),
    } as unknown as Repository<Product>,
    {
      findOne: jest.fn(() =>
        Promise.resolve({ id: ORG, settings: { vatExempt: true } }),
      ),
    } as unknown as Repository<Organization>,
    provider,
    quota,
    new IconSuggestionService(provider, quota),
    gateway,
    cronLock,
    { get: () => uploadDir } as unknown as ConfigService,
    inputFiles,
  );
  const add = (entry: Partial<MenuImport>): Stored => {
    const stored = {
      organizationId: ORG,
      eventId: EVENT,
      userId: 'user-1',
      status: 'queued',
      source: 'images',
      files: [],
      inputText: null,
      usageId: 'usage-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      filesDeletedAt: null,
      ...entry,
    } as Stored;
    imports.set(stored.id, stored);
    return stored;
  };
  return {
    service,
    uploadDir,
    imports,
    add,
    updates,
    extractStructured,
    settle,
    notify,
    importRepository,
    deleteImport,
  };
}

describe('MenuImportWorkerService', () => {
  const extraction = JSON.parse(
    readFileSync(join(FIXTURES, 'getraenke.extraction.json'), 'utf8'),
  ) as unknown;
  const expected = JSON.parse(
    readFileSync(join(FIXTURES, 'getraenke.expected.json'), 'utf8'),
  ) as {
    products: Record<string, unknown>[];
  };
  const cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it('reads the PNG, calls the model once and stores the mapped suggestion with icons', async () => {
    const ctx = setup({ extraction });
    cleanups.push(ctx.uploadDir);
    const png = readFileSync(join(FIXTURES, 'getraenke.png'));
    const stored = await storeFiles(ctx.uploadDir, 'import-1', [
      { buffer: png, mediaType: 'image/png' },
    ]);
    ctx.add({ id: 'import-1', files: stored.map((file) => file.relativePath) });

    await expect(ctx.service.process('import-1')).resolves.toBe(true);

    const request = ctx.extractStructured.mock.calls[0][0] as unknown as {
      purpose: string;
      files: { mediaType: string; data: Buffer }[];
      text: string;
      schemaName: string;
    };
    expect(request.purpose).toBe('extract');
    expect(request.schemaName).toBe('menu_extraction');
    expect(request.files).toHaveLength(1);
    expect(request.files[0].mediaType).toBe('image/png');
    expect(request.files[0].data.equals(png)).toBe(true);
    expect(request.text).toContain('angehängte Datei');

    const result = ctx.imports.get('import-1')!;
    expect(result.status).toBe('done');
    expect(result.usage).toEqual({ inputTokens: 900, outputTokens: 250 });
    expect(result.finishedAt).toBeInstanceOf(Date);
    const suggestion = result.suggestion!;
    expect(suggestion.categories).toEqual([
      { key: 'c1', name: 'Getränke' },
      { key: 'c2', name: 'Sonstiges' },
    ]);
    expect(
      suggestion.products.map((p) => ({ ...p, iconSuggestions: undefined })),
    ).toEqual(
      expected.products.map((p) => ({
        ...p,
        existingProductId: p.name === 'Pils' ? 'prod-pils' : undefined,
        iconSuggestions: undefined,
      })),
    );
    expect(suggestion.products[0].iconSuggestions?.[0]).toEqual({
      icon: 'pos-icon:spezi',
      score: 1,
      source: 'lexical',
    });
    expect(suggestion.products[1].iconSuggestions?.[0]).toEqual({
      icon: 'pos-icon:pils',
      score: 1,
      source: 'lexical',
    });
    expect(suggestion.warnings).toContain(
      'Ein Produkt gibt es in dieser Veranstaltung schon',
    );
    expect(ctx.settle).toHaveBeenCalledWith(
      'usage-1',
      expect.objectContaining({ status: 'ok', inputTokens: 900 }),
    );
    expect(ctx.notify).toHaveBeenCalledWith(ORG, {
      id: 'import-1',
      eventId: EVENT,
      status: 'processing',
    });
    expect(ctx.notify).toHaveBeenLastCalledWith(ORG, {
      id: 'import-1',
      eventId: EVENT,
      status: 'done',
    });
  });

  it('wraps pasted text as untrusted data and sends no files', async () => {
    const ctx = setup({ extraction });
    cleanups.push(ctx.uploadDir);
    ctx.add({
      id: 'import-2',
      source: 'text',
      inputText: readFileSync(join(FIXTURES, 'speisekarte.txt'), 'utf8'),
    });
    await ctx.service.process('import-2');
    const request = ctx.extractStructured.mock.calls[0][0] as unknown as {
      files: unknown[];
      text: string;
      system: string;
    };
    expect(request.files).toEqual([]);
    expect(request.text).toMatch(
      /<untrusted source="menu-text">[\s\S]*Currywurst mit Pommes[\s\S]*<\/untrusted>/,
    );
    expect(request.system).toMatch(/nie Anweisungen/);
    expect(ctx.imports.get('import-2')!.status).toBe('done');
  });

  it('marks the import failed with a user-facing text, keeps the raw message in error_detail and settles the usage as error', async () => {
    const ctx = setup({
      fail: new AiProviderError('Anbieter: Rate-Limit erreicht', 429, true),
    });
    cleanups.push(ctx.uploadDir);
    ctx.add({ id: 'import-3', source: 'text', inputText: 'Bier 3 €' });
    await ctx.service.process('import-3');
    expect(ctx.imports.get('import-3')).toMatchObject({
      status: 'failed',
      error:
        'Der Anbieter ist gerade überlastet, bitte später erneut versuchen.',
      errorDetail: 'Anbieter: Rate-Limit erreicht',
    });
    expect(ctx.settle).toHaveBeenCalledWith('usage-1', { status: 'error' });
    expect(ctx.notify).toHaveBeenLastCalledWith(ORG, {
      id: 'import-3',
      eventId: EVENT,
      status: 'failed',
    });
  });

  it.each([
    [
      'key rejected',
      new AiProviderError('Anbieter: Schlüssel abgelehnt', 401),
      'Der Anbieter hat den Zugang abgelehnt – bitte Schlüssel prüfen.',
    ],
    [
      'key missing',
      new AiProviderError('ANTHROPIC_API_KEY fehlt', undefined, false, 'auth'),
      'Der Anbieter hat den Zugang abgelehnt – bitte Schlüssel prüfen.',
    ],
    [
      'network',
      new AiProviderError('Anbieter nicht erreichbar', undefined, true),
      'Keine Antwort vom Anbieter – bitte später erneut versuchen.',
    ],
    [
      'server error',
      new AiProviderError('Anbieter: Fehler 503', 503, true),
      'Keine Antwort vom Anbieter – bitte später erneut versuchen.',
    ],
    [
      'invalid output',
      new AiProviderError(
        'Das Modell hat keine gültige strukturierte Antwort geliefert',
        undefined,
        false,
        'invalid_output',
      ),
      'Die Speisekarte konnte nicht gelesen werden – versuch ein schärferes Foto oder den Text.',
    ],
    [
      'anything else',
      new Error('ENOENT: page-01.png'),
      'Die Speisekarte konnte nicht ausgewertet werden – bitte versuch es noch einmal.',
    ],
  ])(
    'maps a %s failure to a short German text and keeps the raw message out of error',
    async (_label, failure, expectedText) => {
      const ctx = setup({ fail: failure });
      cleanups.push(ctx.uploadDir);
      ctx.add({ id: 'import-err', source: 'text', inputText: 'Bier 3 €' });
      await ctx.service.process('import-err');
      const stored = ctx.imports.get('import-err')!;
      expect(stored.status).toBe('failed');
      expect(stored.error).toBe(expectedText);
      expect(stored.errorDetail).toBe(failure.message);
      expect(stored.error).not.toContain(failure.message);
    },
  );

  it('stores an empty suggestion with a warning as done when the model finds no product', async () => {
    const ctx = setup({
      extraction: { categories: [], products: [], warnings: [] },
    });
    cleanups.push(ctx.uploadDir);
    ctx.add({ id: 'import-empty', source: 'text', inputText: 'nur Deko' });
    await expect(ctx.service.process('import-empty')).resolves.toBe(true);
    const stored = ctx.imports.get('import-empty')!;
    expect(stored.status).toBe('done');
    expect(stored.error).toBeNull();
    expect(stored.errorDetail).toBeNull();
    expect(stored.suggestion).toEqual({
      categories: [],
      products: [],
      warnings: ['Auf der Speisekarte wurden keine Produkte erkannt.'],
    });
    // Der Aufruf hat stattgefunden und zaehlt im Kontingent.
    expect(ctx.settle).toHaveBeenCalledTimes(1);
    expect(ctx.settle).toHaveBeenCalledWith(
      'usage-1',
      expect.objectContaining({ status: 'ok' }),
    );
    expect(ctx.notify).toHaveBeenLastCalledWith(ORG, {
      id: 'import-empty',
      eventId: EVENT,
      status: 'done',
    });
  });

  it('does nothing for imports that are not queued (already claimed elsewhere)', async () => {
    const ctx = setup({ extraction });
    cleanups.push(ctx.uploadDir);
    ctx.add({
      id: 'import-4',
      status: 'processing',
      source: 'text',
      inputText: 'x',
    });
    await expect(ctx.service.process('import-4')).resolves.toBe(false);
    expect(ctx.extractStructured).not.toHaveBeenCalled();
  });

  it('cleanup removes files after 24 h and whole imports after 30 days', async () => {
    const ctx = setup({ extraction });
    cleanups.push(ctx.uploadDir);
    const png = readFileSync(join(FIXTURES, 'getraenke.png'));
    await storeFiles(ctx.uploadDir, 'old-files', [
      { buffer: png, mediaType: 'image/png' },
    ]);
    await storeFiles(ctx.uploadDir, 'ancient', [
      { buffer: png, mediaType: 'image/png' },
    ]);
    (ctx.importRepository.find as jest.Mock)
      .mockImplementationOnce(() => Promise.resolve([{ id: 'old-files' }]))
      .mockImplementationOnce(() => Promise.resolve([{ id: 'ancient' }]));

    await expect(ctx.service.cleanupNow()).resolves.toEqual({
      filesDeleted: 1,
      importsDeleted: 1,
    });
    expect(existsSync(importDir(ctx.uploadDir, 'old-files'))).toBe(false);
    expect(existsSync(importDir(ctx.uploadDir, 'ancient'))).toBe(false);
    expect(ctx.updates).toContainEqual([
      { id: 'old-files' },
      { filesDeletedAt: expect.any(Date) as unknown },
    ]);
    expect(ctx.deleteImport).toHaveBeenCalledWith({ id: 'ancient' });
  });

  it('recovery fails stuck imports and picks up forgotten queued ones', async () => {
    const ctx = setup({ extraction });
    cleanups.push(ctx.uploadDir);
    const stuck = ctx.add({
      id: 'stuck',
      status: 'processing',
      source: 'text',
      inputText: 'x',
      usageId: 'usage-stuck',
    });
    const forgotten = ctx.add({
      id: 'forgotten',
      status: 'queued',
      source: 'text',
      inputText: 'Bier 3 €',
    });
    (ctx.importRepository.find as jest.Mock)
      .mockImplementationOnce(() => Promise.resolve([structuredClone(stuck)]))
      .mockImplementationOnce(() =>
        Promise.resolve([structuredClone(forgotten)]),
      );

    await ctx.service.recover();

    expect(ctx.imports.get('stuck')).toMatchObject({
      status: 'failed',
      error: 'Die Auswertung wurde abgebrochen – bitte versuch es noch einmal.',
      errorDetail: expect.stringContaining('15 Minuten') as unknown,
    });
    expect(ctx.settle).toHaveBeenCalledWith('usage-stuck', { status: 'error' });
    expect(ctx.imports.get('forgotten')!.status).toBe('done');
  });

  it('splits a long menu by AI_MAX_IMAGES_PER_REQUEST, passes context on and merges the parts', async () => {
    const page = (name: string, category: string, warnings: string[] = []) => ({
      categories: [{ name: category, position: 1 }],
      products: [
        {
          name,
          category,
          description: null,
          price: 3,
          taxRate: 19,
          deposit: { suggested: true, amount: 2 },
          variants: null,
          confidence: 'high',
          note: null,
        },
      ],
      warnings,
    });
    const ctx = setup({
      maxImages: 4,
      extractions: [
        page('Pils', 'Getränke', ['Pfand aus dem Hinweis für alle Getränke']),
        page('Radler', 'Getränke'),
      ],
    });
    cleanups.push(ctx.uploadDir);
    const png = readFileSync(join(FIXTURES, 'getraenke.png'));
    const stored = await storeFiles(
      ctx.uploadDir,
      'import-batch',
      Array.from({ length: 5 }, () => ({
        buffer: png,
        mediaType: 'image/png' as const,
      })),
    );
    ctx.add({
      id: 'import-batch',
      files: stored.map((file) => file.relativePath),
    });

    await ctx.service.process('import-batch');

    expect(ctx.extractStructured).toHaveBeenCalledTimes(2);
    const [first, second] = ctx.extractStructured.mock.calls.map(
      (call) => (call as unknown[])[0] as { files: unknown[]; text: string },
    );
    expect(first.files).toHaveLength(3);
    expect(second.files).toHaveLength(2);
    expect(first.text).toContain('Seiten 1 bis 3');
    expect(first.text).not.toContain('previous-pages');
    expect(second.text).toContain('Seiten 4 bis 5');
    expect(second.text).toMatch(
      /<untrusted source="previous-pages">[\s\S]*Getränke[\s\S]*Pfand aus dem Hinweis[\s\S]*<\/untrusted>/,
    );

    const result = ctx.imports.get('import-batch')!;
    expect(result.status).toBe('done');
    expect(result.usage).toEqual({ inputTokens: 1800, outputTokens: 500 });
    expect(ctx.settle).toHaveBeenCalledTimes(1);
    expect(ctx.settle).toHaveBeenCalledWith(
      'usage-1',
      expect.objectContaining({ status: 'ok', inputTokens: 1800 }),
    );
    expect(result.suggestion!.categories.map((c) => c.name)).toEqual([
      'Getränke',
    ]);
    expect(result.suggestion!.products.map((p) => p.name)).toEqual([
      'Pils',
      'Radler',
    ]);
    expect(result.suggestion!.warnings).toContain(
      'Pfand aus dem Hinweis für alle Getränke',
    );
  });

  it('sends a PDF as page images to a provider without PDF input', async () => {
    const render = jest.fn(() =>
      Promise.resolve([Buffer.from('jpeg-1'), Buffer.from('jpeg-2')]),
    );
    const ctx = setup({
      extraction,
      supportsPdf: false,
      maxImages: 4,
      rasterizer: { render } as unknown as PdfRasterizer,
    });
    cleanups.push(ctx.uploadDir);
    const stored = await storeFiles(ctx.uploadDir, 'import-pdf', [
      {
        buffer: Buffer.from('%PDF-1.4 two pages'),
        mediaType: 'application/pdf',
      },
    ]);
    ctx.add({
      id: 'import-pdf',
      source: 'pdf',
      files: stored.map((file) => file.relativePath),
    });

    await ctx.service.process('import-pdf');

    expect(render).toHaveBeenCalledWith(Buffer.from('%PDF-1.4 two pages'), {
      maxPages: 6,
      longEdgePx: 1600,
    });
    const request = (ctx.extractStructured.mock.calls[0] as unknown[])[0] as {
      files: { mediaType: string }[];
      text: string;
    };
    expect(request.files.map((file) => file.mediaType)).toEqual([
      'image/jpeg',
      'image/jpeg',
    ]);
    expect(request.text).toContain('die 2 angehängten Seiten');
    expect(ctx.imports.get('import-pdf')!.status).toBe('done');
  });

  it('fails with a clear text when the PDF cannot be turned into images', async () => {
    const ctx = setup({
      extraction,
      supportsPdf: false,
      rasterizer: {
        render: () =>
          Promise.reject(new PdfReadError('pdftoppm: Incorrect password')),
      } as unknown as PdfRasterizer,
    });
    cleanups.push(ctx.uploadDir);
    const stored = await storeFiles(ctx.uploadDir, 'import-bad-pdf', [
      { buffer: Buffer.from('%PDF-1.4 locked'), mediaType: 'application/pdf' },
    ]);
    ctx.add({
      id: 'import-bad-pdf',
      source: 'pdf',
      files: stored.map((file) => file.relativePath),
    });

    await ctx.service.process('import-bad-pdf');

    const result = ctx.imports.get('import-bad-pdf')!;
    expect(result.status).toBe('failed');
    expect(result.error).toBe(MENU_IMPORT_PDF_UNREADABLE_TEXT);
    expect(result.errorDetail).toContain('Incorrect password');
    expect(ctx.extractStructured).not.toHaveBeenCalled();
    expect(ctx.settle).toHaveBeenCalledWith('usage-1', { status: 'error' });
  });
});
