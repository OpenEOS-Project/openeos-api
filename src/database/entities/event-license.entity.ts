import { Entity, Column, ManyToOne, JoinColumn, Unique, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { Event } from './event.entity';
import { User } from './user.entity';

@Entity('event_licenses')
@Unique(['eventId', 'licenseDate'])
@Index(['organizationId', 'licenseDate'])
@Index(['eventId'])
export class EventLicense extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @Column({ name: 'license_date', type: 'date' })
  licenseDate: Date;

  @Column({ name: 'credits_used', type: 'int', default: 1 })
  creditsUsed: number;

  @Column({ name: 'activated_at', type: 'timestamp with time zone' })
  activatedAt: Date;

  @Column({ name: 'activated_by_user_id', type: 'uuid' })
  activatedByUserId: string;

  // Relations
  @ManyToOne(() => Organization, (org) => org.eventLicenses, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => Event, (event) => event.eventLicenses, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Event;

  @ManyToOne(() => User, (user) => user.activatedEventLicenses, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'activated_by_user_id' })
  activatedByUser: User;
}
