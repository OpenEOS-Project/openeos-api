import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Betriebsarten (betriebsarten-spec.md, 2026-11-02): eine Einstellung
 * `operating_mode` (`orders_only`, `cashless`, `full`) ersetzt drei
 * Zwischenloesungen. Uebernahme:
 *
 * | vorher                                              | nachher        |
 * |-----------------------------------------------------|----------------|
 * | `settings.operatingMode = 'order_only'`             | `orders_only`  |
 * | `settings.payments.cashless = true`                 | `cashless`     |
 * | `cash_policy_legacy = false` und Land DE            | `cashless`     |
 * |   (Regel „Deutschland ohne Bargeld“)                |                |
 * | alles andere                                        | `full`         |
 *
 * `operating_mode_legacy` (Bestand): `true` fuer jede Organisation, die
 * hier mit `full` herauskommt und unter der Bargeld-Regel Bestandsschutz
 * hatte (alle Organisationen vor 2026-11-01, Selbstbetrieb); sonst `false`.
 * Neue Organisationen starten mit `false`.
 *
 * Verlauf: Die Zeilen des frueheren Support-Schalters in
 * `organization_operating_mode_changes` bekommen die neuen Werte
 * (`pos` → `full`, `order_only` → `orders_only`) und `by_support = true`;
 * jede uebernommene Organisation ausser `full` bekommt eine Zeile
 * „Umstellung auf Betriebsarten (vorher: …)“. Die Tabellen
 * `organization_cashless_changes` und `organization_cash_policy_changes`
 * bleiben als Historie stehen (die zweite weiter fuer Laenderwechsel).
 *
 * Aus `settings` verschwinden `operatingMode`, `operatingModeSince`,
 * `payments.cashless` und `payments.changedAt`. Die Spalten
 * `cash_policy_legacy` und `orders.closed_without_payment_at` bleiben
 * (expand/contract: Altdaten, spaeter entfernen).
 */
export class IntroduceOperatingModes1834000000000 implements MigrationInterface {
  name = 'IntroduceOperatingModes1834000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE organizations
         ADD COLUMN IF NOT EXISTS operating_mode varchar(20) NOT NULL DEFAULT 'full'`,
    );
    await queryRunner.query(
      `ALTER TABLE organizations
         ADD COLUMN IF NOT EXISTS operating_mode_legacy boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE organizations
         ADD COLUMN IF NOT EXISTS operating_mode_since timestamp with time zone NULL`,
    );

    // Verlauf: Grund nur noch beim Support Pflicht, Kennzeichen Support.
    await queryRunner.query(
      `ALTER TABLE organization_operating_mode_changes
         ALTER COLUMN reason DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE organization_operating_mode_changes
         ADD COLUMN IF NOT EXISTS by_support boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE organization_operating_mode_changes
         ALTER COLUMN by_support SET DEFAULT false`,
    );
    await queryRunner.query(`
      UPDATE organization_operating_mode_changes
         SET from_mode = CASE from_mode
                           WHEN 'pos' THEN 'full'
                           WHEN 'order_only' THEN 'orders_only'
                           ELSE from_mode END,
             to_mode = CASE to_mode
                         WHEN 'pos' THEN 'full'
                         WHEN 'order_only' THEN 'orders_only'
                         ELSE to_mode END
       WHERE from_mode IN ('pos', 'order_only')
          OR to_mode IN ('pos', 'order_only')
    `);

    // Uebernahme der Zwischenstaende (nur Zeilen, die noch nie gewechselt
    // haben: operating_mode_since IS NULL — die Migration ist wiederholbar).
    await queryRunner.query(`
      WITH mapped AS (
        SELECT id,
               CASE
                 WHEN settings->>'operatingMode' = 'order_only' THEN 'orders_only'
                 WHEN settings->'payments'->'cashless' = 'true'::jsonb THEN 'cashless'
                 WHEN cash_policy_legacy = false AND upper(coalesce(country, '')) = 'DE'
                   THEN 'cashless'
                 ELSE 'full'
               END AS mode,
               CASE
                 WHEN settings->>'operatingMode' = 'order_only' THEN 'order_only'
                 WHEN settings->'payments'->'cashless' = 'true'::jsonb THEN 'cashless'
                 WHEN cash_policy_legacy = false AND upper(coalesce(country, '')) = 'DE'
                   THEN 'de_policy'
                 ELSE NULL
               END AS source,
               cash_policy_legacy AS legacy_before,
               CASE
                 WHEN settings->>'operatingMode' = 'order_only'
                   AND settings->>'operatingModeSince' ~ '^\\d{4}-\\d{2}-\\d{2}T'
                   THEN (settings->>'operatingModeSince')::timestamptz
                 WHEN settings->'payments'->'cashless' = 'true'::jsonb
                   AND settings->'payments'->>'changedAt' ~ '^\\d{4}-\\d{2}-\\d{2}T'
                   THEN (settings->'payments'->>'changedAt')::timestamptz
                 ELSE NULL
               END AS mode_since,
               created_at
          FROM organizations
         WHERE operating_mode_since IS NULL
      )
      UPDATE organizations o
         SET operating_mode = m.mode,
             operating_mode_legacy = (m.mode = 'full' AND m.legacy_before),
             operating_mode_since = CASE
               WHEN m.mode = 'full' THEN m.created_at
               ELSE coalesce(m.mode_since, now())
             END
        FROM mapped m
       WHERE o.id = m.id
    `);

    await queryRunner.query(`
      INSERT INTO organization_operating_mode_changes
        (organization_id, created_at, from_mode, to_mode, reason, by_support, changed_by_name)
      SELECT o.id,
             now(),
             CASE WHEN o.cash_policy_legacy THEN 'full_legacy' ELSE 'full' END,
             o.operating_mode,
             CASE
               WHEN o.settings->>'operatingMode' = 'order_only'
                 THEN 'Umstellung auf Betriebsarten (vorher: „Nur Bestellen“)'
               WHEN o.settings->'payments'->'cashless' = 'true'::jsonb
                 THEN 'Umstellung auf Betriebsarten (vorher: bargeldloser Modus)'
               ELSE 'Umstellung auf Betriebsarten (vorher: Regel „Deutschland ohne Bargeld“)'
             END,
             true,
             'OpenEOS (Umstellung)'
        FROM organizations o
       WHERE o.operating_mode <> 'full'
         AND NOT EXISTS (
           SELECT 1 FROM organization_operating_mode_changes c
            WHERE c.organization_id = o.id
              AND c.to_mode = o.operating_mode
              AND c.created_at = (
                SELECT max(c2.created_at) FROM organization_operating_mode_changes c2
                 WHERE c2.organization_id = o.id))
    `);

    // Felder der Zwischenloesungen aus den Einstellungen entfernen.
    await queryRunner.query(`
      UPDATE organizations
         SET settings = (settings - 'operatingMode' - 'operatingModeSince')
       WHERE settings ? 'operatingMode' OR settings ? 'operatingModeSince'
    `);
    await queryRunner.query(`
      UPDATE organizations
         SET settings = CASE
               WHEN (settings->'payments') - 'cashless' - 'changedAt' = '{}'::jsonb
                 THEN settings - 'payments'
               ELSE jsonb_set(settings, '{payments}',
                              (settings->'payments') - 'cashless' - 'changedAt')
             END
       WHERE jsonb_typeof(settings->'payments') = 'object'
         AND (settings->'payments' ? 'cashless' OR settings->'payments' ? 'changedAt')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rueckweg nur fuer die Struktur; die Zwischenstaende in `settings`
    // werden nicht wiederhergestellt.
    await queryRunner.query(
      `DELETE FROM organization_operating_mode_changes
        WHERE changed_by_name = 'OpenEOS (Umstellung)'`,
    );
    await queryRunner.query(
      `ALTER TABLE organization_operating_mode_changes DROP COLUMN IF EXISTS by_support`,
    );
    await queryRunner.query(
      `ALTER TABLE organizations DROP COLUMN IF EXISTS operating_mode_since`,
    );
    await queryRunner.query(
      `ALTER TABLE organizations DROP COLUMN IF EXISTS operating_mode_legacy`,
    );
    await queryRunner.query(
      `ALTER TABLE organizations DROP COLUMN IF EXISTS operating_mode`,
    );
  }
}
