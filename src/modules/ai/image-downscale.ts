import sharp from 'sharp';
import type { AiInputFile } from './ai-provider.interface';

/**
 * Lange Kante, auf die Fotos vor dem Senden verkleinert werden. 1600 px
 * reichen fuer Speisekarten (Anbieter-Test 11/2026: Seiten mit 110–150 dpi
 * wurden fehlerfrei gelesen) und sparen Bild-Tokens und Upload-Zeit.
 */
export const MAX_IMAGE_EDGE_PX = 1600;

/** JPEG-Qualitaet fuer verkleinerte Fotos — Schrift bleibt sauber lesbar. */
const JPEG_QUALITY = 85;

/**
 * Verkleinert ein Bild auf hoechstens `maxEdge` px an der langen Kante und
 * dreht es nach seiner EXIF-Ausrichtung (Handyfotos). Ergebnis ist JPEG.
 * Bilder, die schon klein genug und richtig herum sind, bleiben
 * unveraendert; PDFs auch. Kann sharp ein Bild nicht lesen, geht das
 * Original weiter — der Anbieter entscheidet dann.
 */
export async function downscaleImage(
  file: AiInputFile,
  maxEdge = MAX_IMAGE_EDGE_PX,
): Promise<AiInputFile> {
  if (file.mediaType === 'application/pdf') return file;
  try {
    const meta = await sharp(file.data, { failOn: 'none' }).metadata();
    const width = meta.autoOrient?.width ?? meta.width ?? 0;
    const height = meta.autoOrient?.height ?? meta.height ?? 0;
    const rotated = (meta.orientation ?? 1) > 1;
    if (!rotated && Math.max(width, height) <= maxEdge) return file;
    const data = await sharp(file.data, { failOn: 'none' })
      .autoOrient()
      .resize({
        width: maxEdge,
        height: maxEdge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    return { mediaType: 'image/jpeg', data };
  } catch {
    return file;
  }
}
