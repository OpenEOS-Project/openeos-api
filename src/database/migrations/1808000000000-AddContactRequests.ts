import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Zuschriften von der Website ablegen statt nur weiterzuleiten.
 *
 * Ohne Tabelle haengt jede Nachricht daran, dass die Benachrichtigung
 * ankommt. Ist keine Adresse hinterlegt, verschwand sie stillschweigend —
 * und Funktionswuensche will man ohnehin spaeter wieder durchsehen.
 */
export class AddContactRequests1808000000000 implements MigrationInterface {
  name = 'AddContactRequests1808000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS contact_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        type varchar(20) NOT NULL,
        name varchar(200) NOT NULL,
        email varchar(255) NOT NULL,
        organization varchar(255),
        message text NOT NULL,
        notified_at timestamp with time zone,
        handled_at timestamp with time zone
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_contact_requests_type ON contact_requests (type)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_contact_requests_created ON contact_requests (created_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS contact_requests`);
  }
}
