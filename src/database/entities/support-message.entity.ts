import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Organization } from './organization.entity';
import { User } from './user.entity';

export type SupportMessageDirection = 'inbound' | 'outbound';

/**
 * Eine Nachricht im Support-Chat einer Organisation. `inbound` = vom Kunden
 * (Vereinsmitglied) gesendet, `outbound` = vom Plattform-Support. Nachrichten
 * werden nach Telegram gespiegelt (ein Thema je Organisation), daher die
 * optionale `telegramMessageId`.
 */
@Entity('support_messages')
@Index(['organizationId', 'createdAt'])
export class SupportMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 10 })
  direction: SupportMessageDirection;

  @Column({ type: 'text' })
  body: string;

  @Column({ name: 'telegram_message_id', type: 'bigint', nullable: true })
  telegramMessageId: string | null;

  @Column({ name: 'read_by_admin_at', type: 'timestamptz', nullable: true })
  readByAdminAt: Date | null;

  @Column({ name: 'read_by_user_at', type: 'timestamptz', nullable: true })
  readByUserAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  // Relations
  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;
}
