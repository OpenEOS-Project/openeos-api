import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { User } from './user.entity';
import { OrganizationRole } from './user-organization.entity';

@Entity('invitations')
@Index(['token'], { unique: true })
@Index(['organizationId', 'email'])
export class Invitation extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({
    type: 'enum',
    enum: ['admin', 'manager', 'cashier', 'kitchen', 'delivery'],
    enumName: 'organization_role',
  })
  role: OrganizationRole;

  @Column({ type: 'varchar', length: 255, unique: true })
  token: string;

  @Column({ name: 'invited_by_user_id', type: 'uuid' })
  invitedByUserId: string;

  @Column({ name: 'accepted_at', type: 'timestamp with time zone', nullable: true })
  acceptedAt: Date | null;

  @Column({ name: 'expires_at', type: 'timestamp with time zone' })
  expiresAt: Date;

  // Relations
  @ManyToOne(() => Organization, (org) => org.invitations, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => User, (user) => user.sentInvitations, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'invited_by_user_id' })
  invitedByUser: User;

  // Helper methods
  isExpired(): boolean {
    return this.expiresAt < new Date();
  }

  isAccepted(): boolean {
    return this.acceptedAt !== null;
  }

  isValid(): boolean {
    return !this.isExpired() && !this.isAccepted();
  }
}
