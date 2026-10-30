import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { stringify } from 'yaml';

import { AppModule } from '../src/app.module';
import {
  OPENAPI_DOCUMENT_OPTIONS,
  buildOpenApiConfig,
  openApiDescription,
} from '../src/common/openapi/openapi-config';
import { buildPublicSpec } from '../src/common/openapi/public-spec';

/**
 * Schreibt die OpenAPI-Beschreibung in zwei Fassungen:
 *
 * - docs/openapi.json|yaml — vollstaendig, fuer Swagger UI und Self-Hosting
 * - docs/openapi.public.json|yaml — nur, was ein API-Token erreicht, plus
 *   die Token-Verwaltung; davon rendert openeos-docs die Seite /api
 *
 * Dieselbe Konfiguration wie Swagger UI in der Entwicklung
 * (src/common/openapi/openapi-config.ts). Braucht eine erreichbare
 * Datenbank und Redis, weil AppModule beim Start verbindet. Mit
 * `--check` wird nichts geschrieben, sondern nur verglichen: Exit 1, wenn
 * eine eingecheckte Fassung nicht mehr zum Code passt (CI).
 */
async function generateOpenApiSpec() {
  const check = process.argv.includes('--check');

  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.setGlobalPrefix('api');

  const full = SwaggerModule.createDocument(
    app,
    buildOpenApiConfig(),
    OPENAPI_DOCUMENT_OPTIONS,
  );
  await app.close();

  const publicSpec = buildPublicSpec(full, {
    description: openApiDescription('public'),
  });

  const docsDir = join(__dirname, '..', 'docs');
  const outputs: Array<[path: string, content: string]> = [
    [join(docsDir, 'openapi.json'), JSON.stringify(full, null, 2) + '\n'],
    [join(docsDir, 'openapi.yaml'), stringify(full, { lineWidth: 0 })],
    [
      join(docsDir, 'openapi.public.json'),
      JSON.stringify(publicSpec, null, 2) + '\n',
    ],
    [
      join(docsDir, 'openapi.public.yaml'),
      stringify(publicSpec, { lineWidth: 0 }),
    ],
  ];

  if (check) {
    const stale = outputs.filter(([pfad, inhalt]) => {
      try {
        return readFileSync(pfad, 'utf8') !== inhalt;
      } catch {
        return true;
      }
    });
    if (stale.length) {
      console.error(
        `OpenAPI spec out of date: ${stale.map(([p]) => p).join(', ')}\n` +
          'Run `pnpm docs:generate` and commit the result.',
      );
      process.exit(1);
    }
    console.log('OpenAPI spec is up to date.');
    return;
  }

  for (const [pfad, inhalt] of outputs) {
    writeFileSync(pfad, inhalt);
    console.log(`OpenAPI written to: ${pfad}`);
  }
}

generateOpenApiSpec().catch((err) => {
  console.error('Error generating OpenAPI spec:', err);
  process.exit(1);
});
