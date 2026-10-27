import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Event } from './event.entity';

/** Wer storniert hat: die Organisation selbst oder die Plattform (Support). */
export type EventBillingCancellationInitiator = 'organization' | 'platform';

/**
 * - `cancellation`: die Freischaltung ist aufgehoben (Veranstaltung wieder
 *   "nicht freigeschaltet").
 * - `goodwill`: Kulanzerstattung durch die Plattform — ganz oder teilweise,
 *   die Freischaltung bleibt bestehen.
 */
export type EventBillingCancellationKind = 'cancellation' | 'goodwill';

/**
 * Wie das Geld zurueckgeht.
 * - `stripe_refund`: Erstattung der Checkout-Zahlung (ohne Rechnung),
 * - `credit_note_refund`: Stripe-Gutschrift mit Erstattung der Zahlung
 *   (Checkout-Rechnung oder bezahlte Stripe-Rechnung),
 * - `credit_note_out_of_band`: Gutschrift zu einer ausserhalb von Stripe
 *   bezahlten Rechnung — der Betreiber ueberweist selbst zurueck,
 * - `credit_note_open`: Gutschrift auf eine noch offene Rechnung (Kulanz
 *   vor der Zahlung) — kein Geld fliesst, der Rechnungsbetrag sinkt,
 * - `void`: offene Rechnung storniert, nichts zu erstatten,
 * - `manual`: Altfall ohne Stripe-Rechnung, Betreiber von Hand.
 */
export type EventRefundVia =
  | 'stripe_refund'
  | 'credit_note_refund'
  | 'credit_note_out_of_band'
  | 'credit_note_open'
  | 'void'
  | 'manual';

/** Stand der Stripe-Erstattung, wie Stripe ihn meldet. */
export type EventRefundStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'requires_action';

/**
 * Eine stornierte Freischaltung.
 *
 * Bewusst eine eigene Tabelle statt weiterer Spalten an der Veranstaltung:
 * Nach dem Storno faellt die Veranstaltung auf "nicht freigeschaltet"
 * zurueck und kann erneut bezahlt — und erneut storniert — werden. Jede
 * Stornierung bleibt als eigene Zeile stehen; zusammen mit `cancelled_by`
 * und `initiated_by` ist das zugleich das Protokoll, wer wann was
 * zurueckgedreht hat.
 *
 * Die Felder der Freischaltung (bezahlt am, Betrag, Stripe-Sitzung,
 * Rechnungsvermerk) werden hierher kopiert, bevor sie an der
 * Veranstaltung geleert werden.
 */
@Entity('event_billing_cancellations')
@Index('idx_event_billing_cancellations_event', ['eventId', 'createdAt'])
@Index('idx_event_billing_cancellations_org', ['organizationId', 'createdAt'])
export class EventBillingCancellation extends BaseEntity {
  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  /** Nutzer, der storniert hat (Organisations- oder Plattform-Admin). */
  @Column({ name: 'cancelled_by', type: 'uuid', nullable: true })
  cancelledBy: string | null;

  @Column({ name: 'initiated_by', type: 'varchar', length: 20 })
  initiatedBy: EventBillingCancellationInitiator;

  @Column({
    name: 'kind',
    type: 'varchar',
    length: 20,
    default: 'cancellation',
  })
  kind: EventBillingCancellationKind;

  /** Begruendung der Plattform (Pflicht bei Storno/Kulanz durch den Super-Admin). */
  @Column({ name: 'reason', type: 'text', nullable: true })
  reason: string | null;

  /** 'paid' (Stripe) oder 'invoice' (Kauf auf Rechnung). */
  @Column({ name: 'previous_billing_status', type: 'varchar', length: 20 })
  previousBillingStatus: 'paid' | 'invoice';

  /** Erstatteter (bzw. bei Rechnung: gutzuschreibender) Betrag. */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ type: 'varchar', length: 3, default: 'EUR' })
  currency: string;

  @Column({ name: 'paid_at', type: 'timestamp with time zone', nullable: true })
  paidAt: Date | null;

  @Column({ name: 'billed_days', type: 'int', nullable: true })
  billedDays: number | null;

  /** Die Frist, die beim Stornieren galt (null: ohne Beginn bzw. Plattform). */
  @Column({
    name: 'deadline',
    type: 'timestamp with time zone',
    nullable: true,
  })
  deadline: Date | null;

  @Column({
    name: 'stripe_checkout_session_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  stripeCheckoutSessionId: string | null;

  @Column({
    name: 'stripe_payment_intent_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  stripePaymentIntentId: string | null;

  @Column({
    name: 'stripe_invoice_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  stripeInvoiceId: string | null;

  @Column({
    name: 'stripe_refund_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  stripeRefundId: string | null;

  @Column({
    name: 'refund_status',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  refundStatus: EventRefundStatus | null;

  /** Stripe-Gutschrift (Stornorechnung) zur Rechnung aus dem Checkout. */
  @Column({
    name: 'stripe_credit_note_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  stripeCreditNoteId: string | null;

  @Column({
    name: 'credit_note_number',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  creditNoteNumber: string | null;

  /** Kauf auf Rechnung ueber Stripe, noch unbezahlt: Rechnung storniert (void). */
  @Column({ name: 'invoice_voided', type: 'boolean', default: false })
  invoiceVoided: boolean;

  @Column({ name: 'refund_via', type: 'varchar', length: 30, nullable: true })
  refundVia: EventRefundVia | null;

  /**
   * Kauf auf Rechnung, Rechnung schon gestellt: die Rechnung liegt nicht in
   * OpenEOS, die Stornorechnung muss deshalb der Betreiber stellen. Der
   * Vermerk haelt fest, dass das noch aussteht.
   */
  @Column({
    name: 'manual_credit_note_required',
    type: 'boolean',
    default: false,
  })
  manualCreditNoteRequired: boolean;

  /** Rechnungsvermerk der Plattform zur aufgehobenen Bestellung, falls vorhanden. */
  @Column({
    name: 'invoiced_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  invoicedAt: Date | null;

  @Column({ name: 'invoice_note', type: 'text', nullable: true })
  invoiceNote: string | null;

  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Event;
}
