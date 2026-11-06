import sharp from 'sharp';
import { MAX_IMAGE_EDGE_PX, downscaleImage } from './image-downscale';

function photo(width: number, height: number, orientation?: number) {
  const image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 180, b: 150 },
    },
  }).jpeg({ quality: 90 });
  return (orientation ? image.withMetadata({ orientation }) : image).toBuffer();
}

describe('downscaleImage', () => {
  it('shrinks a large photo to 1600 px on the long edge as JPEG', async () => {
    const data = await photo(4000, 3000);
    const result = await downscaleImage({ mediaType: 'image/jpeg', data });
    expect(result.mediaType).toBe('image/jpeg');
    const meta = await sharp(result.data).metadata();
    expect(meta.width).toBe(MAX_IMAGE_EDGE_PX);
    expect(meta.height).toBe(1200);
    expect(result.data.length).toBeLessThan(data.length);
  });

  it('turns a large PNG (with alpha) into a JPEG on white', async () => {
    const data = await sharp({
      create: {
        width: 2400,
        height: 3200,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const result = await downscaleImage({ mediaType: 'image/png', data });
    expect(result.mediaType).toBe('image/jpeg');
    const meta = await sharp(result.data).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 1600]);
    expect(meta.hasAlpha).toBe(false);
  });

  it('applies the EXIF orientation of phone photos', async () => {
    // Querformat-Sensorbild mit "um 90° drehen" → hochkant
    const data = await photo(1200, 800, 6);
    const result = await downscaleImage({ mediaType: 'image/jpeg', data });
    const meta = await sharp(result.data).metadata();
    expect([meta.width, meta.height]).toEqual([800, 1200]);
    expect(meta.orientation ?? 1).toBe(1);
  });

  it('leaves small upright images, PDFs and unreadable data untouched', async () => {
    const small = await photo(1600, 900);
    const kept = { mediaType: 'image/jpeg' as const, data: small };
    await expect(downscaleImage(kept)).resolves.toBe(kept);
    const pdf = {
      mediaType: 'application/pdf' as const,
      data: Buffer.from('%PDF'),
    };
    await expect(downscaleImage(pdf)).resolves.toBe(pdf);
    const broken = {
      mediaType: 'image/png' as const,
      data: Buffer.from('not a png'),
    };
    await expect(downscaleImage(broken)).resolves.toBe(broken);
  });
});
