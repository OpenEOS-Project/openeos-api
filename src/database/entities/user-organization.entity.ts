import { Entity, Column, ManyToOne, JoinColumn, Unique, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';
import { Organization } from './organization.entity';

export enum OrganizationRole {
  ADMIN = 'admin',
  MANAGER = 'manager',
  CASHIER = 'cashier',
  KITCHEN = 'kitchen',
  DELIVERY = 'delivery',
}

export interface OrganizationPermissions {
  canManageProducts?: boolean;
  canManageOrders?: boolean;
  canProcessPayments?: boolean;
  canViewReports?: boolean;
  canManageDevices?: boolean;
  canManageWorkflows?: boolean;
  [key: string]: boolean | undefined;
}

@Entity('user_organizations')
@Unique(['userId', 'organizationId'])
@Index(['userId'])
@Index(['organizationId'])
export class UserOrganization extends BaseEntity {
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({
    type: 'enum',
    enum: ['admin', 'manager', 'cashier', 'kitchen', 'delivery'],
    enumName: 'organization_role',
  })
  role: OrganizationRole;

  @Column({ type: 'jsonb', default: {} })
  permissions: OrganizationPermissions;

  // Relations
  @ManyToOne(() => User, (user) => user.userOrganizations, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Organization, (org) => org.userOrganizations, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;
}
