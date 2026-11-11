import { getMetadataArgsStorage } from 'typeorm';

import * as entities from '../../database/entities';
import {
  ENTITY_SECRET_FIELDS,
  SECRET_FIELDS,
  redactResponse,
} from './response-redaction.util';

/**
 * Jede Spalte jeder Entity einmal durch die Antwort-Schwaerzung: als
 * Entity-Objekt, als Relation und als rohe Abfragezeile.
 *
 * Spalten, deren Name nach Zugangsdaten aussieht, muessen entweder
 * geschwaerzt werden oder hier als unbedenklich gefuehrt sein. Eine neue
 * Spalte mit verdaechtigem Namen laesst diesen Test also scheitern, bis
 * jemand entschieden hat, wohin sie gehoert.
 */
const SUSPICIOUS =
  /token|hash|secret|pin|passw|encrypted|enc$|otp|credential|verification|lookup/i;

/** Geprueft und bewusst sichtbar — mit Grund. */
const REVIEWED_PUBLIC: Record<string, string> = {
  'ApiToken.tokenPrefix': 'erste Zeichen zum Wiedererkennen, kein Geheimnis',
  'WebhookEndpoint.secretHint': 'Anfang des Geheimnisses zum Wiedererkennen',
  'WebhookEndpoint.previousSecretExpiresAt': 'nur ein Zeitpunkt',
  'TseUnit.publicKey': 'oeffentlicher Schluessel der TSE',
  'User.twoFactorEnabled': 'Schalter',
  'User.twoFactorMethod': 'Art des zweiten Faktors',
  'PinCredential.pinLength': 'Laenge, nicht die PIN',
  'User.emailVerificationExpiresAt': 'nur ein Zeitpunkt',
  'ShiftRegistration.verificationReminderCount': 'Zaehler',
  'ShiftRegistration.lastVerificationReminderAt': 'nur ein Zeitpunkt',
  'AiUsage.inputTokens': 'Verbrauchszaehler',
  'AiUsage.outputTokens': 'Verbrauchszaehler',
  'Payment.tokenAmount': 'Wertmarken (Betrag)',
  'Payment.tokenLines': 'Wertmarken (Positionen)',
  'TseTransaction.tokenTransactionId': 'Wertmarken',
};

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- Entity-Klassen jeder Signatur
type EntityClass = Function;

type Column = { entity: string; property: string; dbName: string };

function entityClasses(): Map<string, EntityClass> {
  const classes = new Map<string, EntityClass>();
  for (const value of Object.values(entities)) {
    if (typeof value === 'function') classes.set(value.name, value);
  }
  return classes;
}

function columns(): Column[] {
  const classes = new Set(entityClasses().values());
  const seen = new Set<string>();
  const result: Column[] = [];
  for (const column of getMetadataArgsStorage().columns) {
    const target = column.target as EntityClass;
    if (!classes.has(target)) continue;
    const key = `${target.name}.${column.propertyName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      entity: target.name,
      property: column.propertyName,
      dbName: column.options.name ?? column.propertyName,
    });
  }
  return result;
}

function isGloballyRedacted(column: Column): boolean {
  return SECRET_FIELDS.has(column.property);
}

function isRedacted(column: Column): boolean {
  return (
    isGloballyRedacted(column) ||
    (ENTITY_SECRET_FIELDS[column.entity] ?? []).includes(column.property)
  );
}

const marker = (column: Column) => `MARKER-${column.entity}-${column.property}`;

describe('response redaction across all entities', () => {
  const all = columns();
  const byEntity = new Map<string, Column[]>();
  for (const column of all) {
    byEntity.set(column.entity, [
      ...(byEntity.get(column.entity) ?? []),
      column,
    ]);
  }

  it('finds the entity columns', () => {
    expect(byEntity.size).toBeGreaterThan(50);
    expect(all.find((c) => c.property === 'deviceToken')).toBeDefined();
  });

  it('classifies every column with a credential-like name', () => {
    const unclassified = all
      .filter((c) => SUSPICIOUS.test(c.property))
      .filter((c) => !isRedacted(c))
      .map((c) => `${c.entity}.${c.property}`)
      .filter((key) => !(key in REVIEWED_PUBLIC));
    expect(unclassified).toEqual([]);
  });

  it('keeps the reviewed list free of stale entries', () => {
    const known = new Set(all.map((c) => `${c.entity}.${c.property}`));
    const stale = Object.keys(REVIEWED_PUBLIC).filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  const classes = entityClasses();
  for (const [entity, cols] of byEntity) {
    it(`${entity}: no protected column in the response`, () => {
      const Klass = classes.get(entity)!;
      const instance = Object.create(Klass.prototype as object) as Record<
        string,
        unknown
      >;
      for (const column of cols) instance[column.property] = marker(column);

      // Direkt und als Relation in einer Liste ...
      const out = JSON.stringify(
        redactResponse({ data: instance, items: [{ owner: instance }] }),
      );
      for (const column of cols.filter(isRedacted)) {
        expect(out).not.toContain(marker(column));
      }

      /* ... und als rohe Abfragezeile (`getRawMany`: `<alias>_<spalte>`).
         Dort fehlt die Klasse, also greifen nur die eindeutigen Namen. */
      const raw: Record<string, unknown> = {};
      for (const column of cols) {
        raw[`alias_${column.dbName}`] = marker(column);
      }
      const rawOut = JSON.stringify(redactResponse([raw]));
      for (const column of cols.filter(isGloballyRedacted)) {
        expect(rawOut).not.toContain(marker(column));
      }
      for (const column of cols.filter((c) => !isGloballyRedacted(c))) {
        expect(rawOut).toContain(marker(column));
      }
      // Alles andere bleibt sichtbar (die Schwaerzung ist kein Kahlschlag).
      for (const column of cols.filter((c) => !isRedacted(c))) {
        expect(out).toContain(`"${column.property}":"${marker(column)}"`);
      }
    });
  }
});
