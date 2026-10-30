import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Protokolleintrag fuer schreibende Agenten-Tools (MCP, ki-plan.md
 * Abschnitt 9): `admin_action` bekommt den Wert `agent_tool_call`.
 *
 * Nur Erweiterung (expand); Enum-Werte lassen sich in PostgreSQL nicht
 * entfernen, down() laesst den Wert stehen.
 */
export class AgentToolCallAuditAction1831000000000 implements MigrationInterface {
  name = 'AgentToolCallAuditAction1831000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ALTER TYPE ADD VALUE cannot run inside a transaction in PostgreSQL
    await queryRunner.commitTransaction();
    await queryRunner.query(
      `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS 'agent_tool_call'`,
    );
    await queryRunner.startTransaction();
  }

  public async down(): Promise<void> {
    // Enum-Werte bleiben stehen.
  }
}
