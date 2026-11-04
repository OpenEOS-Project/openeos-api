import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Nachweis der angenommenen AGB- und AVV-Fassungen (`legal_acceptances`).
 *
 * Je Annahme eine Zeile: Benutzer, Organisation (falls vorhanden), Dokument,
 * Fassung (Datum der „Stand“-Zeile), Zeitpunkt, IP-Adresse, Browser und wo
 * angenommen wurde (Registrierung, erneute Annahme, Buchung). Die
 * Fremdschluessel setzen beim Loeschen von Konto oder Organisation nur auf
 * NULL — E-Mail-Adresse und Organisationsname von damals bleiben als
 * Nachweis stehen.
 */
export class CreateLegalAcceptances1838400000000 implements MigrationInterface {
  name = 'CreateLegalAcceptances1838400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS legal_acceptances (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
        user_email varchar(255) NOT NULL,
        organization_id uuid NULL REFERENCES organizations(id) ON DELETE SET NULL,
        organization_name varchar(200) NULL,
        document varchar(10) NOT NULL
          CONSTRAINT "CHK_legal_acceptances_document" CHECK (document IN ('agb', 'avv')),
        version varchar(10) NOT NULL
          CONSTRAINT "CHK_legal_acceptances_version" CHECK (version ~ '^\\d{4}-\\d{2}-\\d{2}$'),
        context varchar(20) NOT NULL
          CONSTRAINT "CHK_legal_acceptances_context" CHECK (context IN ('registration', 'reacceptance', 'purchase')),
        business_confirmed boolean NOT NULL DEFAULT false,
        accepted_at timestamp with time zone NOT NULL DEFAULT now(),
        ip_address varchar(45) NULL,
        user_agent varchar(500) NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_legal_acceptances_user" ON legal_acceptances (user_id, document, accepted_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_legal_acceptances_org" ON legal_acceptances (organization_id, accepted_at)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS legal_acceptances`);
  }
}
