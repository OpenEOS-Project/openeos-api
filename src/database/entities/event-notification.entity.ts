import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Die vier Erinnerungen zu einer Veranstaltung (EventNotificationsService). */
export const EVENT_NOTIFICATION_KINDS = [
  'week_before',
  'day_before',
  'after_event',
  'not_booked',
] as const;
export type EventNotificationKind = (typeof EVENT_NOTIFICATION_KINDS)[number];

export type EventNotificationStatus = 'sending' | 'sent' | 'skipped';

/**
 * Merker „diese Erinnerung ist fuer diesen Termin erledigt“. Eindeutig je
 * Veranstaltung, Art und `scheduleKey` (Kalendertag des Termins, siehe
 * Migration AddEventNotifications). Ohne Empfaengeradressen.
 */
@Entity('event_notifications')
@Index(
  'UQ_event_notifications_event_kind_key',
  ['eventId', 'kind', 'scheduleKey'],
  {
    unique: true,
  },
)
export class EventNotification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 20 })
  kind: EventNotificationKind;

  @Column({ name: 'schedule_key', type: 'varchar', length: 20 })
  scheduleKey: string;

  @Column({ type: 'varchar', length: 20, default: 'sending' })
  status: EventNotificationStatus;

  @Column({ name: 'skip_reason', type: 'varchar', length: 40, nullable: true })
  skipReason: string | null;

  @Column({ type: 'int', default: 0 })
  recipients: number;

  @Column({ name: 'sent_at', type: 'timestamp with time zone', nullable: true })
  sentAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;
}
