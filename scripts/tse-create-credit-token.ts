/**
 * Legt einen Swissbit Credit Token fuer die Plattform an und gibt die
 * Zeilen fuer die .env **einmal** aus (das Secret zeigt Swissbit nur bei
 * der Anlage).
 *
 *   pnpm tse:create-credit-token [--remaining-tses 3] [--product-types 850007,850006]
 *                                [--metadata "OpenEOS prod"]
 *
 * Braucht SWISSBIT_BASE_URL, SWISSBIT_VENDOR_CLIENT und
 * SWISSBIT_VENDOR_SECRET in der Umgebung (oder .env). Die Env-Zeilen gehen
 * auf stdout, alles andere auf stderr — so laesst sich die Ausgabe direkt
 * in eine geschuetzte Datei umleiten, ohne das Secret im Terminal zu
 * zeigen: `pnpm -s tse:create-credit-token > creds.env`.
 */
import 'dotenv/config';

import { SwissbitClient } from '../src/modules/tse/swissbit/swissbit.client';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function env(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    process.stderr.write(`${name} is not set\n`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const baseUrl = env('SWISSBIT_BASE_URL');
  const client = new SwissbitClient({
    baseUrl,
    vendor: {
      client: env('SWISSBIT_VENDOR_CLIENT'),
      secret: env('SWISSBIT_VENDOR_SECRET'),
    },
  });

  const remaining = arg('remaining-tses');
  const productTypes = arg('product-types');
  const metadata =
    arg('metadata') ??
    `OpenEOS platform (${new Date().toISOString().slice(0, 10)})`;

  try {
    const created = await client.createCreditToken({
      metadata,
      ...(remaining !== undefined ? { remainingTses: Number(remaining) } : {}),
      ...(productTypes
        ? { validProductTypes: productTypes.split(',').map((t) => t.trim()) }
        : {}),
    });
    const info = await client.creditTokenInfo({
      clientId: created.value.creditClientId,
      secret: created.value.creditClientSecret,
    });

    process.stderr.write(
      `Credit token created on ${baseUrl} (REQUEST-ID ${created.requestId}).\n` +
        `Valid product types: ${info.value.validProductTypes.join(', ') || '(none)'}\n` +
        `Remaining TSEs: ${info.value.remainingTses ?? 'unlimited'}\n` +
        'The secret is shown only once - store the lines below now.\n',
    );
    process.stdout.write(
      [
        `# Swissbit credit token, created ${new Date().toISOString()} on ${baseUrl}`,
        `SWISSBIT_CREDIT_CLIENT_ID=${created.value.creditClientId}`,
        `SWISSBIT_CREDIT_CLIENT_SECRET=${created.value.creditClientSecret}`,
        `# One of: ${info.value.validProductTypes.join(' ')}`,
        `SWISSBIT_PRODUCT_TYPE=${info.value.validProductTypes[0] ?? ''}`,
        '',
      ].join('\n'),
    );
  } finally {
    client.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
