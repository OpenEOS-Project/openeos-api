import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Schaltet SumUp fuer Organisationen ein, die es bereits eingerichtet haben.
 *
 * Seit Integrationen je Organisation eingeschaltet werden, gilt eine
 * Integration ohne Eintrag unter `settings.integrations` als aus. Ohne diese
 * Migration haetten alle, die heute mit SumUp kassieren, nach dem Update
 * keine Kartenzahlung mehr. Massgeblich ist ein hinterlegter Haendlercode;
 * Organisationen, die bereits einen Eintrag haben, bleiben unangetastet.
 *
 * down() nimmt nur den SumUp-Eintrag wieder heraus und `integrations`
 * selbst, falls danach nichts mehr darin steht. Die Zugangsdaten unter
 * `settings.sumup` fasst die Migration in keiner Richtung an.
 */
export class AddIntegrationActivation1812000000000 implements MigrationInterface {
  name = 'AddIntegrationActivation1812000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE organizations
         SET settings = jsonb_set(
               jsonb_set(
                 settings,
                 '{integrations}',
                 CASE WHEN jsonb_typeof(settings->'integrations') = 'object'
                      THEN settings->'integrations'
                      ELSE '{}'::jsonb
                 END,
                 true
               ),
               '{integrations,sumup}',
               jsonb_build_object(
                 'enabled', true,
                 'enabledAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
               ),
               true
             )
       WHERE COALESCE(settings->'sumup'->>'merchantCode', '') <> ''
         AND settings->'integrations'->'sumup' IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE organizations
         SET settings = settings #- '{integrations,sumup}'
       WHERE settings->'integrations'->'sumup' IS NOT NULL
    `);
    await queryRunner.query(`
      UPDATE organizations
         SET settings = settings - 'integrations'
       WHERE settings->'integrations' = '{}'::jsonb
    `);
  }
}
