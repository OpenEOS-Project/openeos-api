import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCopiedFromEventId1767971967683 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Add copied_from_event_id column to events table
        await queryRunner.query(`
            ALTER TABLE "events"
            ADD COLUMN "copied_from_event_id" uuid NULL
        `);

        // Add foreign key constraint
        await queryRunner.query(`
            ALTER TABLE "events"
            ADD CONSTRAINT "FK_events_copied_from_event"
            FOREIGN KEY ("copied_from_event_id")
            REFERENCES "events"("id")
            ON DELETE SET NULL
        `);

        // Add index for better query performance
        await queryRunner.query(`
            CREATE INDEX "IDX_events_copied_from_event_id"
            ON "events" ("copied_from_event_id")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drop index
        await queryRunner.query(`
            DROP INDEX IF EXISTS "IDX_events_copied_from_event_id"
        `);

        // Drop foreign key constraint
        await queryRunner.query(`
            ALTER TABLE "events"
            DROP CONSTRAINT IF EXISTS "FK_events_copied_from_event"
        `);

        // Drop column
        await queryRunner.query(`
            ALTER TABLE "events"
            DROP COLUMN IF EXISTS "copied_from_event_id"
        `);
    }

}
