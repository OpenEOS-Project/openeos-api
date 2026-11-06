import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AI_PROVIDER } from './ai-provider.interface';
import type { AiInputFile, AiProvider } from './ai-provider.interface';
import { MAX_IMAGE_EDGE_PX, downscaleImage } from './image-downscale';
import { PdfRasterizer } from './pdf-rasterizer';

/**
 * Bereitet hochgeladene Dateien fuer den Modellaufruf vor — fuer alle
 * Anbieter gleich:
 *
 * - Fotos werden auf 1600 px lange Kante verkleinert und nach EXIF gedreht.
 * - Eine PDF geht an Anbieter mit PDF-Eingabe (Anthropic) unveraendert;
 *   fuer alle anderen wird sie in Seitenbilder gewandelt (pdftoppm).
 * - `batches()` teilt die Bilder nach AI_MAX_IMAGES_PER_REQUEST.
 */
@Injectable()
export class AiInputFilesService implements OnModuleInit {
  private readonly logger = new Logger(AiInputFilesService.name);
  private rasterizerAvailable = false;

  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    private readonly rasterizer: PdfRasterizer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.provider.isAvailable() || this.provider.supportsPdf()) return;
    this.rasterizerAvailable = await this.rasterizer.isAvailable();
    if (this.rasterizerAvailable) {
      this.logger.log(
        `PDF-Import für ${this.provider.name}: Seiten werden als Bilder gesendet (pdftoppm)`,
      );
    } else {
      this.logger.warn(
        `PDF-Import für ${this.provider.name} aus: pdftoppm/pdfinfo (poppler-utils) nicht gefunden — nur Bilder und Text`,
      );
    }
  }

  /** Nimmt der Import PDFs an — direkt oder als Seitenbilder? */
  pdfSupported(): boolean {
    return this.provider.supportsPdf() || this.rasterizerAvailable;
  }

  /** Wird eine PDF vor dem Senden in Bilder gewandelt (und zaehlen ihre Seiten)? */
  rasterizesPdf(): boolean {
    return !this.provider.supportsPdf() && this.rasterizerAvailable;
  }

  /** Seitenzahl einer PDF (wirft PdfReadError, wenn sie nicht lesbar ist). */
  pdfPageCount(pdf: Buffer): Promise<number> {
    return this.rasterizer.pageCount(pdf);
  }

  /**
   * Dateien in Seitenreihenfolge fuer den Aufruf: PDFs ggf. als
   * Seitenbilder (hoechstens `maxPages`), Fotos verkleinert.
   */
  async prepare(
    files: AiInputFile[],
    options: { maxPages: number },
  ): Promise<AiInputFile[]> {
    const prepared: AiInputFile[] = [];
    for (const file of files) {
      if (file.mediaType === 'application/pdf') {
        if (this.provider.supportsPdf()) {
          prepared.push(file);
          continue;
        }
        const pages = await this.rasterizer.render(file.data, {
          maxPages: options.maxPages,
          longEdgePx: MAX_IMAGE_EDGE_PX,
        });
        prepared.push(
          ...pages.map((data) => ({ mediaType: 'image/jpeg' as const, data })),
        );
        continue;
      }
      prepared.push(await downscaleImage(file));
    }
    return prepared;
  }

  /** Teilt die Dateien nach AI_MAX_IMAGES_PER_REQUEST (gleich grosse Teile). */
  batches(files: AiInputFile[]): AiInputFile[][] {
    return splitIntoBatches(files, this.provider.maxImagesPerRequest());
  }
}

/**
 * Teilt `items` in moeglichst gleich grosse, zusammenhaengende Teile von
 * hoechstens `max` Eintraegen (5 Seiten bei max 4 → 3 + 2, nicht 4 + 1).
 * Ohne Grenze oder leer: ein Teil.
 */
export function splitIntoBatches<T>(items: T[], max: number | null): T[][] {
  if (!max || max <= 0 || items.length <= max) return [items];
  const count = Math.ceil(items.length / max);
  const base = Math.floor(items.length / count);
  const extra = items.length % count;
  const batches: T[][] = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const size = base + (index < extra ? 1 : 0);
    batches.push(items.slice(offset, offset + size));
    offset += size;
  }
  return batches;
}
