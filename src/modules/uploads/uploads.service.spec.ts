import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { UploadCategory } from './dto';
import { MulterFile, UploadsService } from './uploads.service';

// `uuid` ist ein reines ESM-Paket, das Jest je nach pnpm-Layout nicht
// transformiert; fuer die Tests genuegt Nodes eigene Implementierung.
jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

/**
 * Uploads duerfen den Bereich ihres Eigentuemers nicht verlassen — weder
 * beim Schreiben noch beim Loeschen oder Lesen.
 */
describe('UploadsService: Pfade', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';
  const FREMD = '22222222-2222-4222-8222-222222222222';

  let root: string;
  let service: UploadsService;

  const png: MulterFile = {
    fieldname: 'file',
    originalname: 'shell.js',
    encoding: '7bit',
    mimetype: 'image/png',
    size: 4,
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  } as MulterFile;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'uploads-'));
    service = new UploadsService({
      get: () => root,
    } as unknown as ConfigService);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('legt eine Datei im eigenen Bereich ab, mit Endung aus dem MIME-Typ', async () => {
    const result = await service.uploadImage(png, ORG, UploadCategory.PRODUCT);

    // Nicht `.js` aus dem Original-Dateinamen.
    expect(result.filename).toMatch(/\.png$/);
    await expect(
      fs.access(path.join(root, ORG, 'product', result.filename)),
    ).resolves.toBeUndefined();
  });

  it('lehnt eine Kategorie mit Pfadanteilen ab', async () => {
    await expect(
      service.uploadImage(
        png,
        ORG,
        `../${FREMD}/product` as unknown as UploadCategory,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(fs.readdir(root)).resolves.not.toContain(FREMD);
  });

  it('lehnt einen Eigentuemer mit Pfadanteilen ab', async () => {
    await expect(
      service.uploadImage(png, `${ORG}/../${FREMD}`, UploadCategory.PRODUCT),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('loescht nichts ausserhalb des eigenen Bereichs', async () => {
    const fremdeDatei = path.join(
      root,
      FREMD,
      'product',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
    );
    await fs.mkdir(path.dirname(fremdeDatei), { recursive: true });
    await fs.writeFile(fremdeDatei, 'bild');

    await service.deleteImage(
      ORG,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
      `../${FREMD}/product` as unknown as UploadCategory,
    );

    await expect(fs.readFile(fremdeDatei, 'utf8')).resolves.toBe('bild');
  });

  it('wirft beim Loeschen nicht, wenn der Name keiner gespeicherten Datei entspricht', async () => {
    // Der Avatar-Tausch uebergibt den letzten Teil einer alten URL.
    await expect(
      service.deleteImage(ORG, 'avatar?size=200', UploadCategory.USER),
    ).resolves.toBeUndefined();
  });

  it('liefert keinen Pfad ausserhalb des Bereichs', async () => {
    await expect(
      service.getImagePath(ORG, 'package.json', '../../..'),
    ).resolves.toBeNull();
    await expect(
      service.getImagePath(
        ORG,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
        `../${FREMD}/product`,
      ),
    ).resolves.toBeNull();
  });

  it('findet eine eigene, regulaer abgelegte Datei', async () => {
    const { filename } = await service.uploadImage(
      png,
      ORG,
      UploadCategory.EVENT,
    );
    await expect(service.getImagePath(ORG, filename, 'event')).resolves.toBe(
      path.join(root, ORG, 'event', filename),
    );
  });
});
