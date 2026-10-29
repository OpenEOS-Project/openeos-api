import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { stringify } from 'yaml';

import { AppModule } from '../src/app.module';
import { buildOpenApiConfig } from '../src/common/openapi/openapi-config';

/**
 * Schreibt docs/openapi.json und docs/openapi.yaml.
 *
 * Dieselbe Konfiguration wie Swagger UI in der Entwicklung
 * (src/common/openapi/openapi-config.ts). Braucht eine erreichbare
 * Datenbank und Redis, weil AppModule beim Start verbindet. Mit
 * `--check` wird nichts geschrieben, sondern nur verglichen: Exit 1, wenn
 * die eingecheckte Fassung nicht mehr zum Code passt (CI).
 */
async function generateOpenApiSpec() {
  const check = process.argv.includes('--check');

  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.setGlobalPrefix('api');

  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
  await app.close();

  const json = JSON.stringify(document, null, 2) + '\n';
  const yaml = stringify(document, { lineWidth: 0 });
  const jsonPath = join(__dirname, '..', 'docs', 'openapi.json');
  const yamlPath = join(__dirname, '..', 'docs', 'openapi.yaml');

  if (check) {
    const { readFileSync } = await import('fs');
    const stale = [
      [jsonPath, json],
      [yamlPath, yaml],
    ].filter(([pfad, inhalt]) => {
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

  writeFileSync(jsonPath, json);
  console.log(`OpenAPI JSON written to: ${jsonPath}`);
  writeFileSync(yamlPath, yaml);
  console.log(`OpenAPI YAML written to: ${yamlPath}`);
}

generateOpenApiSpec().catch((err) => {
  console.error('Error generating OpenAPI spec:', err);
  process.exit(1);
});
