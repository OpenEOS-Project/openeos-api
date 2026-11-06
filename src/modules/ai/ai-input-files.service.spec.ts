import sharp from 'sharp';
import {
  AiInputFilesService,
  splitIntoBatches,
} from './ai-input-files.service';
import type { AiInputFile, AiProvider } from './ai-provider.interface';
import { PdfRasterizer } from './pdf-rasterizer';

function setup(options: {
  supportsPdf: boolean;
  rasterizer?: boolean;
  maxImages?: number | null;
  available?: boolean;
}) {
  const provider = {
    name: options.supportsPdf ? 'anthropic' : 'openai',
    isAvailable: () => options.available ?? true,
    supportsPdf: () => options.supportsPdf,
    maxImagesPerRequest: () => options.maxImages ?? null,
  } as unknown as AiProvider;
  const render = jest.fn(() =>
    Promise.resolve([Buffer.from('jpg-1'), Buffer.from('jpg-2')]),
  );
  const isAvailable = jest.fn(() =>
    Promise.resolve(options.rasterizer ?? false),
  );
  const rasterizer = {
    isAvailable,
    pageCount: jest.fn(() => Promise.resolve(2)),
    render,
  } as unknown as PdfRasterizer;
  return {
    service: new AiInputFilesService(provider, rasterizer),
    render,
    isAvailable,
  };
}

const pdf: AiInputFile = {
  mediaType: 'application/pdf',
  data: Buffer.from('%PDF-1.4'),
};

describe('splitIntoBatches', () => {
  it('keeps everything in one call without a limit or below it', () => {
    expect(splitIntoBatches([1, 2, 3], null)).toEqual([[1, 2, 3]]);
    expect(splitIntoBatches([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
    expect(splitIntoBatches([1, 2, 3, 4], 4)).toEqual([[1, 2, 3, 4]]);
    expect(splitIntoBatches([], 4)).toEqual([[]]);
  });

  it('splits into even, ordered parts of at most max entries', () => {
    expect(splitIntoBatches([1, 2, 3, 4, 5], 4)).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    expect(splitIntoBatches([1, 2, 3, 4, 5, 6], 4)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(splitIntoBatches([1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]);
    for (let n = 1; n <= 20; n += 1) {
      const items = Array.from({ length: n }, (_, i) => i);
      const batches = splitIntoBatches(items, 4);
      expect(batches.flat()).toEqual(items);
      expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(4);
    }
  });
});

describe('AiInputFilesService', () => {
  it('passes PDFs through for providers that read them (Anthropic)', async () => {
    const { service, render, isAvailable } = setup({ supportsPdf: true });
    await service.onModuleInit();
    expect(isAvailable).not.toHaveBeenCalled();
    expect(service.pdfSupported()).toBe(true);
    expect(service.rasterizesPdf()).toBe(false);
    await expect(service.prepare([pdf], { maxPages: 6 })).resolves.toEqual([
      pdf,
    ]);
    expect(render).not.toHaveBeenCalled();
  });

  it('turns a PDF into page images when the provider cannot read PDFs and pdftoppm is there', async () => {
    const { service, render } = setup({ supportsPdf: false, rasterizer: true });
    expect(service.pdfSupported()).toBe(false);
    await service.onModuleInit();
    expect(service.pdfSupported()).toBe(true);
    expect(service.rasterizesPdf()).toBe(true);
    const files = await service.prepare([pdf], { maxPages: 6 });
    expect(render).toHaveBeenCalledWith(pdf.data, {
      maxPages: 6,
      longEdgePx: 1600,
    });
    expect(files).toEqual([
      { mediaType: 'image/jpeg', data: Buffer.from('jpg-1') },
      { mediaType: 'image/jpeg', data: Buffer.from('jpg-2') },
    ]);
  });

  it('reports no PDF support without pdftoppm', async () => {
    const { service } = setup({ supportsPdf: false, rasterizer: false });
    await service.onModuleInit();
    expect(service.pdfSupported()).toBe(false);
    expect(service.rasterizesPdf()).toBe(false);
  });

  it('downscales photos for every provider and batches by the provider limit', async () => {
    const big = await sharp({
      create: {
        width: 3000,
        height: 4000,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .jpeg()
      .toBuffer();
    const { service } = setup({ supportsPdf: true, maxImages: 4 });
    const [file] = await service.prepare(
      [{ mediaType: 'image/jpeg', data: big }],
      { maxPages: 6 },
    );
    const meta = await sharp(file.data).metadata();
    expect(meta.height).toBe(1600);
    const pages = Array.from({ length: 6 }, () => file);
    expect(service.batches(pages).map((batch) => batch.length)).toEqual([3, 3]);
  });
});
