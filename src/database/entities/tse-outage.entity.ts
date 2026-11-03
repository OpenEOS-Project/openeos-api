import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { TseUnit } from './tse-unit.entity';

/**
 * Ausfallprotokoll (AEAO zu § 146a Nr. 1.14): Beginn beim ersten
 * gescheiterten Vorgang, Ende beim naechsten erfolgreichen. Hoechstens ein
 * offener Ausfall je TSE (Teilindex).
 */
@Entity('tse_outages')
@Index('IDX_tse_outages_org', ['organizationId', 'startedAt'])
export class TseOutage extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'tse_unit_id', type: 'uuid' })
  tseUnitId: string;

  @ManyToOne(() => TseUnit, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'tse_unit_id' })
  tseUnit?: TseUnit;

  @Column({ name: 'started_at', type: 'timestamp with time zone' })
  startedAt: Date;

  @Column({
    name: 'ended_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  endedAt: Date | null;

  /** Fehlercode des ersten gescheiterten Vorgangs. */
  @Column({ type: 'varchar', length: 60 })
  reason: string;

  @Column({
    name: 'last_error_message',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  lastErrorMessage: string | null;

  @Column({ name: 'failed_count', type: 'int', default: 0 })
  failedCount: number;

  @Column({
    name: 'notified_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  notifiedAt: Date | null;
}
