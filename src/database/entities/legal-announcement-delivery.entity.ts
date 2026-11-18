import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export const LEGAL_ANNOUNCEMENT_DELIVERY_STATES = [
  'pending',
  'sending',
  'sent',
  'failed',
] as const;
export type LegalAnnouncementDeliveryState =
  (typeof LEGAL_ANNOUNCEMENT_DELIVERY_STATES)[number];

/**
 * Eine Mail einer Ankuendigung an eine Adresse (eine Zeile je Adresse,
 * eindeutig ohne Gross-/Kleinschreibung).
 *
 * Die Empfaenger werden beim Anlegen der Ankuendigung festgehalten; der
 * Versand laeuft danach im Hintergrund (`LegalAnnouncementMailer`). Vor dem
 * Senden wird die Zeile beansprucht (`sending`), so geht jede Mail
 * hoechstens einmal raus — auch nach einem Neustart oder mit mehreren
 * Instanzen.
 */
@Entity('legal_announcement_deliveries')
@Index('IDX_legal_announcement_deliveries_announcement', [
  'announcementId',
  'status',
])
export class LegalAnnouncementDelivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'announcement_id', type: 'uuid' })
  announcementId: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ name: 'first_name', type: 'varchar', length: 100, nullable: true })
  firstName: string | null;

  @Column({ type: 'varchar', length: 10, default: 'pending' })
  status: LegalAnnouncementDeliveryState;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  error: string | null;

  @Column({
    name: 'claimed_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  claimedAt: Date | null;

  @Column({ name: 'sent_at', type: 'timestamp with time zone', nullable: true })
  sentAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;
}
