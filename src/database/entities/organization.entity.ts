import { Entity, Column, OneToMany, Index } from 'typeorm';
import { SoftDeleteEntity } from './base.entity';
import { UserOrganization } from './user-organization.entity';
import { Event } from './event.entity';
import { Device } from './device.entity';
import { Printer } from './printer.entity';
import { PrintTemplate } from './print-template.entity';
import { Workflow } from './workflow.entity';
import { Order } from './order.entity';
import { QrCode } from './qr-code.entity';
import { Invitation } from './invitation.entity';
import { CreditPurchase } from './credit-purchase.entity';
import { EventLicense } from './event-license.entity';
import { Invoice } from './invoice.entity';
import { RentalAssignment } from './rental-assignment.entity';

export interface OrganizationSettings {
  currency: string;
  timezone: string;
  locale: string;
  taxId?: string;
  address?: {
    street: string;
    city: string;
    zip: string;
    country: string;
  };
  contact?: {
    email: string;
    phone?: string;
  };
  receipt?: {
    headerText?: string;
    footerText?: string;
    showTaxDetails: boolean;
  };
  pos?: {
    requireTableNumber: boolean;
    autoPrintReceipt: boolean;
    soundEnabled: boolean;
    orderingMode: 'immediate' | 'tab';
  };
  onlineOrdering?: {
    enabled: boolean;
    requirePayment: boolean;
    maxItemsPerOrder: number;
  };
}

export interface BillingAddress {
  company?: string;
  street: string;
  city: string;
  zip: string;
  country: string;
}

export enum DiscountType {
  ALL = 'all',
  CREDITS = 'credits',
  HARDWARE = 'hardware',
}

export enum SubscriptionStatus {
  ACTIVE = 'active',
  PAST_DUE = 'past_due',
  CANCELED = 'canceled',
  INCOMPLETE = 'incomplete',
  TRIALING = 'trialing',
}

@Entity('organizations')
@Index(['slug'], { unique: true })
export class Organization extends SoftDeleteEntity {
  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 100, unique: true })
  slug: string;

  @Column({ name: 'logo_url', type: 'varchar', length: 500, nullable: true })
  logoUrl: string | null;

  @Column({ type: 'jsonb', default: {} })
  settings: OrganizationSettings;

  @Column({ name: 'event_credits', type: 'int', default: 0 })
  eventCredits: number;

  @Column({ name: 'billing_email', type: 'varchar', length: 255, nullable: true })
  billingEmail: string | null;

  @Column({ name: 'billing_address', type: 'jsonb', nullable: true })
  billingAddress: BillingAddress | null;

  @Column({ name: 'support_pin', type: 'varchar', length: 6 })
  supportPin: string;

  @Column({ name: 'discount_percent', type: 'decimal', precision: 5, scale: 2, nullable: true })
  discountPercent: number | null;

  @Column({ name: 'discount_type', type: 'enum', enum: DiscountType, enumName: 'discount_type', nullable: true })
  discountType: DiscountType | null;

  @Column({ name: 'discount_valid_until', type: 'date', nullable: true })
  discountValidUntil: Date | null;

  @Column({ name: 'discount_note', type: 'text', nullable: true })
  discountNote: string | null;

  // Stripe Fields
  @Column({ name: 'stripe_customer_id', type: 'varchar', length: 255, nullable: true })
  stripeCustomerId: string | null;

  @Column({ name: 'stripe_subscription_id', type: 'varchar', length: 255, nullable: true })
  stripeSubscriptionId: string | null;

  @Column({ name: 'subscription_status', type: 'enum', enum: SubscriptionStatus, enumName: 'subscription_status', nullable: true })
  subscriptionStatus: SubscriptionStatus | null;

  @Column({ name: 'subscription_current_period_end', type: 'timestamp with time zone', nullable: true })
  subscriptionCurrentPeriodEnd: Date | null;

  @Column({ name: 'subscription_credits_granted_at', type: 'timestamp with time zone', nullable: true })
  subscriptionCreditsGrantedAt: Date | null;

  // Relations
  @OneToMany(() => UserOrganization, (userOrg) => userOrg.organization)
  userOrganizations: UserOrganization[];

  @OneToMany(() => Event, (event) => event.organization)
  events: Event[];

  @OneToMany(() => Device, (device) => device.organization)
  devices: Device[];

  @OneToMany(() => Printer, (printer) => printer.organization)
  printers: Printer[];

  @OneToMany(() => PrintTemplate, (template) => template.organization)
  printTemplates: PrintTemplate[];

  @OneToMany(() => Workflow, (workflow) => workflow.organization)
  workflows: Workflow[];

  @OneToMany(() => Order, (order) => order.organization)
  orders: Order[];

  @OneToMany(() => QrCode, (qrCode) => qrCode.organization)
  qrCodes: QrCode[];

  @OneToMany(() => Invitation, (invitation) => invitation.organization)
  invitations: Invitation[];

  @OneToMany(() => CreditPurchase, (purchase) => purchase.organization)
  creditPurchases: CreditPurchase[];

  @OneToMany(() => EventLicense, (license) => license.organization)
  eventLicenses: EventLicense[];

  @OneToMany(() => Invoice, (invoice) => invoice.organization)
  invoices: Invoice[];

  @OneToMany(() => RentalAssignment, (rental) => rental.organization)
  rentalAssignments: RentalAssignment[];
}
