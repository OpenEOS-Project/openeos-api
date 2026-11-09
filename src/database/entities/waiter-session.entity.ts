import { Column, Entity } from 'typeorm';
import { BaseEntity } from './base.entity';

export const WAITER_SESSION_END_REASONS = [
  'lock',
  'switch',
  'timeout',
  'logout',
  'revoked',
  'device_blocked',
] as const;
export type WaiterSessionEndReason =
  (typeof WAITER_SESSION_END_REASONS)[number];

/**
 * Anmeldung einer Bedienung (`waiterId`) oder eines Mitglieds (`userId`)
 * an einem Geraet. Das Token kennt nur das Geraet (im Speicher); hier steht
 * sein SHA-256. Geloescht nach 90 Tagen (Loeschlauf, P4).
 */
@Entity('waiter_sessions')
export class WaiterSession extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'device_id', type: 'uuid' })
  deviceId: string;

  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId: string | null;

  @Column({ name: 'waiter_id', type: 'uuid', nullable: true })
  waiterId: string | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash: string;

  @Column({
    name: 'started_at',
    type: 'timestamp with time zone',
    default: () => 'now()',
  })
  startedAt: Date;

  @Column({
    name: 'last_seen_at',
    type: 'timestamp with time zone',
    default: () => 'now()',
  })
  lastSeenAt: Date;

  @Column({
    name: 'ended_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  endedAt: Date | null;

  @Column({ name: 'end_reason', type: 'varchar', length: 20, nullable: true })
  endReason: WaiterSessionEndReason | null;
}
