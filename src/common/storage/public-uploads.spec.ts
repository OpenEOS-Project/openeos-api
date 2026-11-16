import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { request as httpRequest } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import * as path from 'path';
import { mountPublicUploads, publicUploadPath } from './public-uploads';

const ORG = '3f0c8a1e-5b7d-4c2a-9e1f-0a1b2c3d4e5f';
const IMAGE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d.png';

@Controller('ping')
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}

@Module({ controllers: [PingController] })
class TestModule {}

/** Rohe Anfrage ohne Normalisierung durch den Client. */
function rawGet(port: number, rawPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: rawPath, method: 'GET' },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('public upload paths', () => {
  it('accepts only <uuid>/<category>/<file>', () => {
    expect(publicUploadPath(`/${ORG}/product/${IMAGE}`)).toBe(
      `/${ORG}/product/${IMAGE}`,
    );
    expect(publicUploadPath(`/${ORG}//product/${IMAGE}?v=2`)).toBe(
      `/${ORG}/product/${IMAGE}`,
    );
    for (const bad of [
      `/menu-imports/${ORG}/page-01.png`,
      `/tse-exports/${ORG}/dsfinvk/Z000001.zip`,
      `/${ORG}/dsfinvk/${IMAGE}`,
      `/${ORG}/product/.hidden.png`,
      `/${ORG}/product/..%2f..%2fmenu-imports`,
      `/${ORG}/product/${IMAGE}%00.png`,
      `/${ORG}/product/a%5cb.png`,
      `/.private/menu-imports/${ORG}/page-01.png`,
      `/%E0%A4%A`,
      '/',
    ]) {
      expect(publicUploadPath(bad)).toBeNull();
    }
  });
});

describe('serving /uploads', () => {
  let app: NestExpressApplication;
  let port: number;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'public-uploads-'));
    const uploads = path.join(root, 'uploads');
    const put = (rel: string) => {
      const file = path.join(uploads, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'x');
    };
    put(`${ORG}/product/${IMAGE}`);
    // Was frueher im Upload-Verzeichnis lag, darf nie ausgeliefert werden.
    put(`menu-imports/${ORG}/page-01.png`);
    put(`tse-exports/${ORG}/dsfinvk/Z000001_2026-11-01.zip`);
    put(`.private/menu-imports/${ORG}/page-01.png`);
    put(`${ORG}/notes/readme.txt`);

    app = await NestFactory.create<NestExpressApplication>(TestModule, {
      logger: false,
    });
    mountPublicUploads(app, uploads);
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves public images', async () => {
    expect(await rawGet(port, `/uploads/${ORG}/product/${IMAGE}`)).toBe(200);
    expect(await rawGet(port, `/uploads/${ORG}/product/${IMAGE}?v=1`)).toBe(
      200,
    );
    expect(await rawGet(port, '/api/ping')).toBe(200);
  });

  it.each([
    `/uploads/menu-imports/${ORG}/page-01.png`,
    `/uploads/tse-exports/${ORG}/dsfinvk/Z000001_2026-11-01.zip`,
    `/uploads//menu-imports/${ORG}/page-01.png`,
    `/uploads///tse-exports/${ORG}/dsfinvk/Z000001_2026-11-01.zip`,
    `//uploads/menu-imports/${ORG}/page-01.png`,
    `/uploads/./menu-imports/${ORG}/page-01.png`,
    `/uploads/x/../menu-imports/${ORG}/page-01.png`,
    `/uploads/${ORG}/product/../../menu-imports/${ORG}/page-01.png`,
    `/uploads/%6denu-imports/${ORG}/page-01.png`,
    `/uploads/menu-imports%2f${ORG}%2fpage-01.png`,
    `/uploads/%2e/menu-imports/${ORG}/page-01.png`,
    `/uploads/%2e%2e/uploads/menu-imports/${ORG}/page-01.png`,
    `/uploads/%252e/menu-imports/${ORG}/page-01.png`,
    `/uploads/%25252e/menu-imports/${ORG}/page-01.png`,
    `/uploads/tse-exports%252f${ORG}%252fdsfinvk%252fZ000001_2026-11-01.zip`,
    `/uploads%2fmenu-imports/${ORG}/page-01.png`,
    `/Uploads/menu-imports/${ORG}/page-01.png`,
    `/UPLOADS/tse-exports/${ORG}/dsfinvk/Z000001_2026-11-01.zip`,
    `/uploads\\menu-imports\\${ORG}\\page-01.png`,
    `/uploads/%5cmenu-imports/${ORG}/page-01.png`,
    `/uploads/.private/menu-imports/${ORG}/page-01.png`,
    `/uploads/${ORG}/notes/readme.txt`,
    `/uploads/${ORG}/product/`,
    '/uploads/',
    '/uploads',
    `/api/../uploads/menu-imports/${ORG}/page-01.png`,
  ])('answers 404 for %s', async (rawPath) => {
    expect(await rawGet(port, rawPath)).toBe(404);
  });
});
