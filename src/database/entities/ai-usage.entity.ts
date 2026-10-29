import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';
import { Organization } from './organization.entity';
import { User } from './user.entity';

/** Wofuer ein Modell aufgerufen wurde — Schluessel fuer die Kontingente. */
export type AiFeature = 'menu_import' | 'icon_suggest';

export type AiUsageStatus = 'reserved' | 'ok' | 'error';

/**
 * Ein Eintrag je Modellaufruf: Tokens, Dauer, Ergebnis. Grundlage fuer die
 * Tageskontingente (AiQuotaService), fuers Monitoring und spaeter fuer
 * eine Abrechnung. `units` zaehlt, wie viele Kontingent-Einheiten der
 * Aufruf verbraucht (ein Import = 1, eine Klassifikation je Name = 1).
 */
@Entity('ai_usage')
@Index(['organizationId', 'feature', 'createdAt'])
export class AiUsage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 40 })
  feature: AiFeature;

  @Column({ type: 'varchar', length: 20 })
  provider: string;

  @Column({ type: 'varchar', length: 100 })
  model: string;

  @Column({ type: 'int', default: 1 })
  units: number;

  @Column({ name: 'input_tokens', type: 'int', default: 0 })
  inputTokens: number;

  @Column({ name: 'output_tokens', type: 'int', default: 0 })
  outputTokens: number;

  @Column({ name: 'duration_ms', type: 'int', default: 0 })
  durationMs: number;

  @Column({ type: 'varchar', length: 20, default: 'reserved' })
  status: AiUsageStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;
}
