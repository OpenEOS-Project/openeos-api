import { Entity, Column, OneToMany, Index } from 'typeorm';
import { SoftDeleteEntity } from './base.entity';
import { UserOrganization } from './user-organization.entity';
import { RefreshToken } from './refresh-token.entity';
import { Invitation } from './invitation.entity';
import { Order } from './order.entity';
import { Payment } from './payment.entity';
import { StockMovement } from './stock-movement.entity';
import { InventoryCount } from './inventory-count.entity';
import { CreditPurchase } from './credit-purchase.entity';
import { EventLicense } from './event-license.entity';
import { AdminAuditLog } from './admin-audit-log.entity';
import { TrustedDevice } from './trusted-device.entity';
import { EmailOtp } from './email-otp.entity';

export enum TwoFactorMethod {
  TOTP = 'totp',
  EMAIL = 'email',
}

export interface UserPreferences {
  theme: 'light' | 'dark' | 'system';
  locale: 'de' | 'en';
  notifications: {
    email: boolean;
    push: boolean;
  };
}

@Entity('users')
@Index(['email'], { unique: true })
export class User extends SoftDeleteEntity {
  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 255 })
  passwordHash: string;

  @Column({ name: 'first_name', type: 'varchar', length: 100 })
  firstName: string;

  @Column({ name: 'last_name', type: 'varchar', length: 100 })
  lastName: string;

  @Column({ name: 'avatar_url', type: 'varchar', length: 500, nullable: true })
  avatarUrl: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'is_superadmin', type: 'boolean', default: false })
  isSuperAdmin: boolean;

  @Column({ name: 'email_verified_at', type: 'timestamp with time zone', nullable: true })
  emailVerifiedAt: Date | null;

  @Column({ name: 'last_login_at', type: 'timestamp with time zone', nullable: true })
  lastLoginAt: Date | null;

  @Column({ name: 'failed_login_attempts', type: 'int', default: 0 })
  failedLoginAttempts: number;

  @Column({ name: 'locked_until', type: 'timestamp with time zone', nullable: true })
  lockedUntil: Date | null;

  @Column({ name: 'password_reset_token', type: 'varchar', length: 255, nullable: true })
  passwordResetToken: string | null;

  @Column({ name: 'password_reset_expires_at', type: 'timestamp with time zone', nullable: true })
  passwordResetExpiresAt: Date | null;

  // 2FA Fields
  @Column({ name: 'two_factor_enabled', type: 'boolean', default: false })
  twoFactorEnabled: boolean;

  @Column({ name: 'two_factor_method', type: 'enum', enum: TwoFactorMethod, enumName: 'two_factor_method', nullable: true })
  twoFactorMethod: TwoFactorMethod | null;

  @Column({ name: 'two_factor_secret_encrypted', type: 'text', nullable: true })
  twoFactorSecretEncrypted: string | null;

  @Column({ name: 'two_factor_backup_codes_hash', type: 'text', nullable: true })
  twoFactorBackupCodesHash: string | null;

  // User Preferences
  @Column({ type: 'jsonb', default: { theme: 'system', locale: 'de', notifications: { email: true, push: true } } })
  preferences: UserPreferences;

  // Pending Email Change
  @Column({ name: 'pending_email', type: 'varchar', length: 255, nullable: true })
  pendingEmail: string | null;

  @Column({ name: 'pending_email_token', type: 'varchar', length: 255, nullable: true })
  pendingEmailToken: string | null;

  @Column({ name: 'pending_email_expires_at', type: 'timestamp with time zone', nullable: true })
  pendingEmailExpiresAt: Date | null;

  // Relations
  @OneToMany(() => UserOrganization, (userOrg) => userOrg.user)
  userOrganizations: UserOrganization[];

  @OneToMany(() => RefreshToken, (token) => token.user)
  refreshTokens: RefreshToken[];

  @OneToMany(() => Invitation, (invitation) => invitation.invitedByUser)
  sentInvitations: Invitation[];

  @OneToMany(() => Order, (order) => order.createdByUser)
  createdOrders: Order[];

  @OneToMany(() => Payment, (payment) => payment.processedByUser)
  processedPayments: Payment[];

  @OneToMany(() => StockMovement, (movement) => movement.createdByUser)
  stockMovements: StockMovement[];

  @OneToMany(() => InventoryCount, (count) => count.createdByUser)
  createdInventoryCounts: InventoryCount[];

  @OneToMany(() => InventoryCount, (count) => count.completedByUser)
  completedInventoryCounts: InventoryCount[];

  @OneToMany(() => CreditPurchase, (purchase) => purchase.purchasedByUser)
  creditPurchases: CreditPurchase[];

  @OneToMany(() => EventLicense, (license) => license.activatedByUser)
  activatedEventLicenses: EventLicense[];

  @OneToMany(() => AdminAuditLog, (log) => log.adminUser)
  adminAuditLogs: AdminAuditLog[];

  @OneToMany(() => TrustedDevice, (device) => device.user)
  trustedDevices: TrustedDevice[];

  @OneToMany(() => EmailOtp, (otp) => otp.user)
  emailOtps: EmailOtp[];

  // Helper methods
  get fullName(): string {
    return `${this.firstName} ${this.lastName}`;
  }

  isLocked(): boolean {
    return this.lockedUntil !== null && this.lockedUntil > new Date();
  }
}
