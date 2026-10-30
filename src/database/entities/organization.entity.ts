import { Entity, Column, OneToMany, Index } from 'typeorm';
import { SoftDeleteEntity } from './base.entity';
import { UserOrganization } from './user-organization.entity';
import { Event } from './event.entity';
import { Device } from './device.entity';
import { Printer } from './printer.entity';
import { PrintTemplate } from './print-template.entity';
import { Order } from './order.entity';
import { QrCode } from './qr-code.entity';
import { Invitation } from './invitation.entity';
import { Invoice } from './invoice.entity';

/**
 * Rechtliche Angaben des Vereins fuer seine oeffentlichen Seiten (Shop,
 * Helferseiten). Verkauft wird im Namen des Vereins, Helferdaten erhebt der
 * Verein — Impressum (§ 5 DDG) und Datenschutzhinweis (Art. 13 DSGVO) muessen
 * deshalb von ihm kommen, nicht von OpenEOS.
 *
 * Je Angabe entweder ein Link auf die eigene Seite des Vereins oder ein
 * Freitext, den OpenEOS selbst anzeigt. Beides zugleich ist nicht erlaubt,
 * siehe normalizeLegalSettings().
 */
export interface OrganizationLegalSettings {
  imprintUrl?: string;
  imprintText?: string;
  privacyUrl?: string;
  privacyText?: string;
  /** Kontaktadresse fuer Datenschutzanfragen, optional. */
  contactEmail?: string;
}

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
  /**
   * Weist die Organisation Umsatzsteuer aus?
   *
   * Vereine und Kleinunternehmer nach § 19 UStG tun das nicht; fuer sie
   * gibt es am Produkt nur den Satz 0. Bewusst ein Schalter und keine
   * Rechtsform: aus "Verein" laesst sich die Steuerpflicht nicht sicher
   * ableiten, auch ein Verein kann steuerpflichtig sein.
   */
  vatExempt?: boolean;
  legal?: OrganizationLegalSettings;
  pos?: {
    /**
     * Sofort kassieren oder auf Deckel buchen. Der einzige Wert aus dem
     * frueheren POS-Block, den die Kassen-UI tatsaechlich liest — er liegt
     * jetzt je Veranstaltung, weil sich die Betriebsart von Fest zu Fest
     * unterscheidet. Bleibt hier als Rueckfallwert fuer Bestandsdaten.
     */
    orderingMode?: 'immediate' | 'tab';
  };
  /**
   * When/where deposits (Pfand) are charged, by fulfillment type.
   * Defaults when unset: no Pfand for table service, Pfand for counter/takeaway.
   */
  pfand?: {
    tableService?: boolean;
    counterPickup?: boolean;
  };
  /**
   * Zahlungsarten der Organisation. `cashless: true` sperrt Bargeld an
   * allen Einstiegen (siehe cashless-mode.util.ts) — ohne Bargeld braucht
   * die Kasse keine TSE. Fehlt der Eintrag, ist Bargeld erlaubt.
   */
  payments?: {
    cashless?: boolean;
    /** Letzte Umschaltung (ISO); Verlauf in organization_cashless_changes. */
    changedAt?: string;
  };
  /**
   * Assistent-Funktionen (Speisekarten-Import, Icon-Vorschlaege). Opt-in
   * je Organisation durch einen Admin; das Einschalten steht im
   * Admin-Protokoll. Siehe ki-plan.md Abschnitt 6.2.
   */
  assistant?: {
    enabled: boolean;
    enabledAt?: string;
    enabledByUserId?: string;
  };
  onlineOrdering?: {
    enabled: boolean;
    requirePayment: boolean;
    maxItemsPerOrder: number;
  };
  sumup?: {
    apiKey: string;
    merchantCode: string;
    affiliateKey?: string;
    appId?: string;
  };
  paypal?: {
    clientId: string;
    clientSecret: string;
  };
  /**
   * Schalter je Integration (Schluessel aus INTEGRATION_IDS). Getrennt von
   * den Zugangsdaten (`sumup` oben): Ausschalten laesst die hinterlegten
   * Daten stehen, damit ein spaeteres Einschalten ohne Neueingabe geht.
   */
  integrations?: Record<string, { enabled: boolean; enabledAt?: string }>;
  orderFlow?: {
    receiptPrinting?: {
      enabled: boolean;
      trigger: 'payment_received' | 'order_completed' | 'manual';
      printerId: string | null;
      templateId: string | null;
    };
    kitchenTicketPrinting?: {
      enabled: boolean;
      printerId: string | null;
      templateId: string | null;
      /**
       * How kitchen tickets are split:
       * - per_order   : one ticket containing the entire order (default, legacy)
       * - per_item    : one ticket per OrderItem (with item-barcode for scan tracking)
       * - per_station : one ticket per ProductionStation, routed to the station's
       *                 printer if it has one, falling back to printerId above.
       */
      mode?: 'per_order' | 'per_item' | 'per_station';
    };
    orderTicketPrinting?: {
      enabled: boolean;
      printerId: string | null;
      templateId: string | null;
    };
    kitchenDisplay?: { enabled: boolean };
    customerDisplay?: { enabled: boolean };
    autoComplete?: { enabled: boolean };
  };
}

export interface BillingAddress {
  company?: string;
  /** Kauf-auf-Rechnung: no dedicated `billingName` column exists, so the
   *  billing contact name is folded into this jsonb blob instead. */
  name?: string;
  street: string;
  city: string;
  zip: string;
  country: string;
}

export type OrganizationBillingMode = 'prepaid' | 'invoice';

export enum DiscountType {
  ALL = 'all',
  CREDITS = 'credits',
  /**
   * @deprecated Hardware-Vermietung gibt es nicht mehr (2026-10). Der Wert
   * bleibt, weil `organizations.discount_type` ihn noch enthalten kann.
   */
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

  @Column({
    name: 'billing_email',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  billingEmail: string | null;

  @Column({ name: 'billing_address', type: 'jsonb', nullable: true })
  billingAddress: BillingAddress | null;

  @Column({ name: 'support_pin', type: 'varchar', length: 6 })
  supportPin: string;

  @Column({
    name: 'discount_percent',
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
  })
  discountPercent: number | null;

  @Column({
    name: 'discount_type',
    type: 'enum',
    enum: DiscountType,
    enumName: 'discount_type',
    nullable: true,
  })
  discountType: DiscountType | null;

  @Column({ name: 'discount_valid_until', type: 'date', nullable: true })
  discountValidUntil: Date | null;

  @Column({ name: 'discount_note', type: 'text', nullable: true })
  discountNote: string | null;

  // Stripe Fields
  @Column({
    name: 'stripe_customer_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  stripeCustomerId: string | null;

  @Column({
    name: 'stripe_subscription_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  stripeSubscriptionId: string | null;

  @Column({
    name: 'subscription_status',
    type: 'enum',
    enum: SubscriptionStatus,
    enumName: 'subscription_status',
    nullable: true,
  })
  subscriptionStatus: SubscriptionStatus | null;

  @Column({
    name: 'subscription_current_period_end',
    type: 'timestamp with time zone',
    nullable: true,
  })
  subscriptionCurrentPeriodEnd: Date | null;

  // Event billing (pay-per-event activation)
  @Column({
    name: 'billing_mode',
    type: 'varchar',
    length: 20,
    default: 'prepaid',
  })
  billingMode: OrganizationBillingMode;

  @Column({
    name: 'event_price_override',
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: true,
  })
  eventPriceOverride: number | null;

  /**
   * Zahlungsziel fuer Rechnungen (Kauf auf Rechnung ueber Stripe) in Tagen.
   * Leer: der Standard der Plattform (STRIPE_INVOICE_DAYS_UNTIL_DUE).
   */
  @Column({ name: 'invoice_days_until_due', type: 'int', nullable: true })
  invoiceDaysUntilDue: number | null;

  // Support Chat
  @Column({ name: 'priority_support', type: 'boolean', default: false })
  prioritySupport: boolean;

  /**
   * Eigene Obergrenze fuer Mitglieder (aktive plus offene Einladungen).
   * NULL: es gilt MEMBERS_PER_ORGANIZATION_LIMIT; 0: unbegrenzt. Setzt nur
   * ein Super-Admin.
   */
  @Column({ name: 'member_limit', type: 'int', nullable: true })
  memberLimit: number | null;

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

  @OneToMany(() => Order, (order) => order.organization)
  orders: Order[];

  @OneToMany(() => QrCode, (qrCode) => qrCode.organization)
  qrCodes: QrCode[];

  @OneToMany(() => Invitation, (invitation) => invitation.organization)
  invitations: Invitation[];

  @OneToMany(() => Invoice, (invoice) => invoice.organization)
  invoices: Invoice[];
}
