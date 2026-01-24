import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { Event } from './event.entity';
import { OnlineOrderSession } from './online-order-session.entity';

export enum QrCodeType {
  TABLE = 'table',
  TAKEAWAY = 'takeaway',
  EVENT = 'event',
}

@Entity('qr_codes')
@Index(['organizationId', 'code'])
@Index(['eventId'])
export class QrCode extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId: string | null;

  @Column({ type: 'varchar', length: 50 })
  code: string;

  @Column({ type: 'enum', enum: QrCodeType, enumName: 'qr_code_type' })
  type: QrCodeType;

  @Column({ name: 'table_number', type: 'varchar', length: 20, nullable: true })
  tableNumber: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  name: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'scan_count', type: 'int', default: 0 })
  scanCount: number;

  @Column({ name: 'last_scanned_at', type: 'timestamp with time zone', nullable: true })
  lastScannedAt: Date | null;

  // Relations
  @ManyToOne(() => Organization, (org) => org.qrCodes, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => Event, (event) => event.qrCodes, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'event_id' })
  event: Event | null;

  @OneToMany(() => OnlineOrderSession, (session) => session.qrCode)
  sessions: OnlineOrderSession[];
}
