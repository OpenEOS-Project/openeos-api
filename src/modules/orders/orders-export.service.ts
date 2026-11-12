import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  Order,
  Organization,
  User,
  UserOrganization,
} from '../../database/entities';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import type { SelectedOption } from '../../database/entities/order-item.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  OPERATING_MODE_SELECT,
  isOrdersOnly,
} from '../../common/utils/operating-mode.util';
import {
  CSV_BOM,
  csvHeader,
  csvLine,
  csvMoney,
  csvNumber,
  csvText,
} from '../../common/utils/csv.util';
import { localDateKey } from '../../common/utils/date-range.util';
import {
  displayStatusOf,
  type OrderDisplayStatus,
} from '../refunds/refund-calc';
import { ExportOrdersDto, OrdersExportVariant } from './dto';
import { OrdersService } from './orders.service';

/** Zeitzone der Datums- und Uhrzeitspalten. */
export const EXPORT_TIME_ZONE = 'Europe/Berlin';

/** Bestellungen je Datenbankabfrage beim Schreiben der Datei. */
const BATCH_SIZE = 500;

const DATE_FORMAT = new Intl.DateTimeFormat('de-DE', {
  timeZone: EXPORT_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const TIME_FORMAT = new Intl.DateTimeFormat('de-DE', {
  timeZone: EXPORT_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Gleiche Bezeichnungen wie in der Bestellliste der Verwaltung. */
const DISPLAY_STATUS_LABEL: Record<OrderDisplayStatus, string> = {
  in_kitchen: 'In Küche',
  ready: 'Fertig',
  completed: 'Abgeschlossen',
  unpaid: 'Offen – nicht bezahlt',
  cancelled: 'Storniert',
  partly_refunded: 'Teilweise erstattet',
  refunded: 'Erstattet',
};

const ITEM_STATUS_LABEL: Record<string, string> = {
  pending: 'Offen',
  preparing: 'In Arbeit',
  ready: 'Fertig',
  delivered: 'Serviert',
  cancelled: 'Storniert',
};

const CHANNEL_LABEL: Record<string, string> = {
  pos: 'Kasse',
  online: 'Online-Shop',
  qr_order: 'QR-Bestellung',
};

const FULFILLMENT_LABEL: Record<string, string> = {
  table_service: 'Am Tisch',
  counter_pickup: 'Abholung',
};

const PAYMENT_LABEL: Record<string, string> = {
  cash: 'Bar',
  card: 'Karte',
  sumup_terminal: 'SumUp',
  sumup_online: 'SumUp online',
  // PayPal: nur fruehere Zahlungen (Anbindung seit 1.8 entfernt).
  paypal: 'PayPal',
  google_pay: 'Google Pay',
  apple_pay: 'Apple Pay',
};

/** Zahlungsanbieter (`payments.payment_provider`); Bargeld hat keinen. */
const PROVIDER_LABEL: Record<string, string> = {
  CARD: 'Kartenterminal (extern)',
  SUMUP: 'SumUp',
  PAYPAL: 'PayPal',
};

/** Eine Bestellung, wie die Exportabfrage sie liefert (Postgres-Rohwerte). */
export interface OrderExportRow {
  id: string;
  order_number: string;
  daily_number: number;
  created_at: Date;
  status: string;
  payment_status: string;
  source: string;
  fulfillment_type: string;
  table_number: string | null;
  subtotal: string | number;
  discount_amount: string | number;
  pfand_total: string | number;
  tip_amount: string | number;
  total: string | number;
  paid_amount: string | number;
  refunded_amount: string | number;
  tax_total: string | number;
  is_test: boolean;
  customer_name: string | null;
  notes: string | null;
  closed_without_payment_at: Date | null;
  event_name: string | null;
  device_name: string | null;
  /** Verantwortliche Bedienung (Tisch), sonst die aufnehmende. */
  waiter_name: string | null;
  payment_methods: string[] | null;
  /** Anbieter der Zahlungen (ohne Bargeld). */
  payment_providers: string[] | null;
  /** Transaktions-IDs beim Anbieter, aelteste Zahlung zuerst. */
  payment_references: string[] | null;
  /** Referenzen der Erstattungen beim Anbieter. */
  refund_references: string[] | null;
  item_count: string | number;
}

/** Eine Bestellposition samt Kopfdaten ihrer Bestellung. */
export interface OrderItemExportRow {
  order_number: string;
  created_at: Date;
  table_number: string | null;
  is_test: boolean;
  event_name: string | null;
  product_name: string;
  category_name: string | null;
  options: { selected?: SelectedOption[] } | null;
  quantity: number;
  refunded_quantity: number;
  unit_price: string | number;
  options_price: string | number;
  tax_rate: string | number;
  deposit_amount: string | number;
  deposit_tax_rate: string | number | null;
  total_price: string | number;
  status: string;
  notes: string | null;
  station_name: string | null;
}

export interface CsvColumn<T> {
  header: string;
  /** Betrag — faellt in der Betriebsart „Nur Bons“ weg. */
  money?: boolean;
  value: (row: T, ctx: { orderOnly: boolean }) => string;
}

const yesNo = (value: boolean) => (value ? 'Ja' : 'Nein');

export function exportDate(value: Date | string): string {
  return DATE_FORMAT.format(new Date(value));
}

export function exportTime(value: Date | string): string {
  return TIME_FORMAT.format(new Date(value));
}

function paymentLabel(row: OrderExportRow): string {
  const labels = [...new Set(row.payment_methods ?? [])]
    .sort()
    .map((m) => PAYMENT_LABEL[m] ?? m);
  if (!labels.length && row.closed_without_payment_at) {
    return 'Ohne Zahlung abgeschlossen';
  }
  return labels.join(', ');
}

function providerLabel(row: OrderExportRow): string {
  return [...new Set(row.payment_providers ?? [])]
    .sort()
    .map((p) => PROVIDER_LABEL[p] ?? p)
    .join(', ');
}

const joined = (values: string[] | null) => (values ?? []).join(', ');

/**
 * Spalten der Datei „Bestellungen“ (eine Zeile je Bestellung). Gastname
 * und Anmerkung stehen nur, solange sie gespeichert sind — die
 * Aufbewahrung leert sie 30 Tage nach der Veranstaltung. Die
 * Telefonnummer bleibt bewusst draussen: sie dient nur der Rueckfrage
 * waehrend der Veranstaltung und gehoert nicht in eine Auswertung.
 */
export const ORDER_COLUMNS: ReadonlyArray<CsvColumn<OrderExportRow>> = [
  { header: 'Bestellnummer', value: (r) => csvText(r.order_number) },
  { header: 'Tagesnummer', value: (r) => csvNumber(r.daily_number) },
  { header: 'Datum', value: (r) => exportDate(r.created_at) },
  { header: 'Uhrzeit', value: (r) => exportTime(r.created_at) },
  { header: 'Veranstaltung', value: (r) => csvText(r.event_name) },
  {
    header: 'Status',
    value: (r, { orderOnly }) =>
      csvText(
        DISPLAY_STATUS_LABEL[
          displayStatusOf(
            {
              status: r.status,
              paymentStatus: r.payment_status,
              total: Number(r.total),
              paidAmount: Number(r.paid_amount),
              refundedAmount: Number(r.refunded_amount),
              closedWithoutPaymentAt: r.closed_without_payment_at,
            },
            { orderOnly },
          )
        ],
      ),
  },
  {
    header: 'Kanal',
    value: (r) => csvText(CHANNEL_LABEL[r.source] ?? r.source),
  },
  {
    header: 'Ausgabe',
    value: (r) =>
      csvText(FULFILLMENT_LABEL[r.fulfillment_type] ?? r.fulfillment_type),
  },
  { header: 'Tisch', value: (r) => csvText(r.table_number) },
  { header: 'Gerät', value: (r) => csvText(r.device_name) },
  { header: 'Bedienung', value: (r) => csvText(r.waiter_name) },
  { header: 'Artikel', value: (r) => csvNumber(r.item_count) },
  { header: 'Zahlart', money: true, value: (r) => csvText(paymentLabel(r)) },
  /* Zahlungsanbieter und Referenz (GoBD, Abgleich mit der Abrechnung von
     SumUp bzw. frueher PayPal): Transaktions-ID der Zahlung, sonst
     SumUp-Checkout bzw. PayPal-Order (Altdaten) aus den Metadaten. Mehrere mit „, “. */
  {
    header: 'Zahlungsanbieter',
    money: true,
    value: (r) => csvText(providerLabel(r)),
  },
  {
    header: 'Zahlungsreferenz',
    money: true,
    value: (r) => csvText(joined(r.payment_references)),
  },
  { header: 'Zwischensumme', money: true, value: (r) => csvMoney(r.subtotal) },
  { header: 'Rabatt', money: true, value: (r) => csvMoney(r.discount_amount) },
  { header: 'Pfand', money: true, value: (r) => csvMoney(r.pfand_total) },
  { header: 'Trinkgeld', money: true, value: (r) => csvMoney(r.tip_amount) },
  { header: 'Gesamt', money: true, value: (r) => csvMoney(r.total) },
  { header: 'Bezahlt', money: true, value: (r) => csvMoney(r.paid_amount) },
  {
    header: 'Erstattet',
    money: true,
    value: (r) => csvMoney(r.refunded_amount),
  },
  {
    header: 'Erstattungsreferenz',
    money: true,
    value: (r) => csvText(joined(r.refund_references)),
  },
  {
    header: 'Enthaltene MwSt',
    money: true,
    value: (r) => csvMoney(r.tax_total),
  },
  { header: 'Testbestellung', value: (r) => yesNo(r.is_test) },
  { header: 'Gastname', value: (r) => csvText(r.customer_name) },
  { header: 'Anmerkung', value: (r) => csvText(r.notes) },
];

/** Spalten der Datei „Positionen“ (eine Zeile je Bestellposition). */
export const ITEM_COLUMNS: ReadonlyArray<CsvColumn<OrderItemExportRow>> = [
  { header: 'Bestellnummer', value: (r) => csvText(r.order_number) },
  { header: 'Datum', value: (r) => exportDate(r.created_at) },
  { header: 'Uhrzeit', value: (r) => exportTime(r.created_at) },
  { header: 'Veranstaltung', value: (r) => csvText(r.event_name) },
  { header: 'Tisch', value: (r) => csvText(r.table_number) },
  { header: 'Produkt', value: (r) => csvText(r.product_name) },
  { header: 'Kategorie', value: (r) => csvText(r.category_name) },
  {
    header: 'Variante',
    value: (r) =>
      csvText(
        (r.options?.selected ?? [])
          .map((o) => o.option)
          .filter(Boolean)
          .join(', '),
      ),
  },
  { header: 'Menge', value: (r) => csvNumber(r.quantity) },
  { header: 'Erstattete Menge', value: (r) => csvNumber(r.refunded_quantity) },
  {
    header: 'Einzelpreis',
    money: true,
    value: (r) => csvMoney(Number(r.unit_price) + Number(r.options_price)),
  },
  { header: 'MwSt-Satz (%)', money: true, value: (r) => csvNumber(r.tax_rate) },
  {
    header: 'Pfand je Stück',
    money: true,
    value: (r) => csvMoney(r.deposit_amount),
  },
  {
    // Satz des Pfands (Teil des Entgelts). Leer: kein Pfand bzw. Buchung
    // von vor 2026-11 — damals nicht steuerbar (0 %).
    header: 'Pfand MwSt-Satz (%)',
    money: true,
    value: (r) =>
      Number(r.deposit_amount) !== 0 && r.deposit_tax_rate !== null
        ? csvNumber(r.deposit_tax_rate)
        : '',
  },
  {
    header: 'Positionssumme',
    money: true,
    value: (r) => csvMoney(r.total_price),
  },
  {
    header: 'Status',
    value: (r) => csvText(ITEM_STATUS_LABEL[r.status] ?? r.status),
  },
  { header: 'Station', value: (r) => csvText(r.station_name) },
  { header: 'Testbestellung', value: (r) => yesNo(r.is_test) },
  { header: 'Anmerkung', value: (r) => csvText(r.notes) },
];

/** Spalten fuer die Betriebsart: in „Nur Bons“ ohne Betraege. */
export function columnsFor<T>(
  columns: ReadonlyArray<CsvColumn<T>>,
  orderOnly: boolean,
): ReadonlyArray<CsvColumn<T>> {
  return orderOnly ? columns.filter((c) => !c.money) : columns;
}

/** Zeilen als CSV (ohne Kopfzeile). */
export function csvRows<T>(
  columns: ReadonlyArray<CsvColumn<T>>,
  rows: readonly T[],
  orderOnly: boolean,
): string {
  return rows
    .map((row) => csvLine(columns.map((c) => c.value(row, { orderOnly }))))
    .join('');
}

export interface OrdersExport {
  filename: string;
  /** Datei in Stuecken: BOM und Kopfzeile, dann je Block Bestellungen. */
  chunks: AsyncGenerator<string>;
}

const ORDER_SQL = `
  SELECT o.id, o.order_number, o.daily_number, o.created_at, o.status,
         o.payment_status, o.source, o.fulfillment_type, o.table_number,
         o.subtotal, o.discount_amount, o.pfand_total, o.tip_amount, o.total,
         o.paid_amount, o.refunded_amount, o.tax_total, o.is_test,
         o.customer_name, o.notes, o.closed_without_payment_at,
         e.name AS event_name, d.name AS device_name,
         COALESCE(w.name, cw.name) AS waiter_name,
         (SELECT array_agg(DISTINCT p.payment_method::text)
            FROM payments p
           WHERE p.order_id = o.id AND p.status IN ('captured', 'refunded')
         ) AS payment_methods,
         (SELECT array_agg(DISTINCT p.payment_provider::text)
            FROM payments p
           WHERE p.order_id = o.id AND p.status IN ('captured', 'refunded')
             AND p.payment_provider::text <> 'CASH'
         ) AS payment_providers,
         (SELECT array_agg(ref ORDER BY created_at, id)
            FROM (SELECT p.id, p.created_at,
                         COALESCE(NULLIF(p.provider_transaction_id, ''),
                                  NULLIF(p.metadata->>'paypalOrderId', ''),
                                  NULLIF(p.metadata->>'checkoutId', '')) AS ref
                    FROM payments p
                   WHERE p.order_id = o.id
                     AND p.status IN ('captured', 'refunded')) pr
           WHERE ref IS NOT NULL
         ) AS payment_references,
         (SELECT array_agg(r.provider_reference ORDER BY r.created_at, r.id)
            FROM refunds r
           WHERE r.order_id = o.id AND NULLIF(r.provider_reference, '') IS NOT NULL
         ) AS refund_references,
         (SELECT COALESCE(SUM(oi.quantity), 0)
            FROM order_items oi
           WHERE oi.order_id = o.id AND oi.status <> 'cancelled'
         ) AS item_count
    FROM orders o
    LEFT JOIN events e ON e.id = o.event_id
    LEFT JOIN devices d ON d.id = o.created_by_device_id
    LEFT JOIN waiters w ON w.id = o.waiter_id
    LEFT JOIN waiters cw ON cw.id = o.created_by_waiter_id
   WHERE o.id = ANY($1::uuid[])
   ORDER BY o.created_at, o.id`;

const ITEM_SQL = `
  SELECT o.order_number, o.created_at, o.table_number, o.is_test,
         e.name AS event_name,
         oi.product_name, oi.category_name, oi.options, oi.quantity,
         oi.refunded_quantity, oi.unit_price, oi.options_price, oi.tax_rate,
         oi.deposit_amount, oi.deposit_tax_rate, oi.total_price, oi.status, oi.notes,
         ps.name AS station_name
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN events e ON e.id = o.event_id
    LEFT JOIN production_stations ps ON ps.id = oi.production_station_id
   WHERE oi.order_id = ANY($1::uuid[])
   ORDER BY o.created_at, o.id, oi.sort_order, oi.created_at, oi.id`;

/**
 * CSV-Export der Bestellliste: dieselben Filter wie `GET …/orders`,
 * geschrieben in Bloecken, damit auch grosse Feste nicht im Speicher
 * landen. Nur Admins und Mitglieder mit dem Recht „Bestellungen“.
 */
@Injectable()
export class OrdersExportService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(UserOrganization)
    private readonly memberRepository: Repository<UserOrganization>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    private readonly ordersService: OrdersService,
  ) {}

  /**
   * Prueft Rechte und Filter und ermittelt die Bestellungen — Fehler
   * kommen also, bevor die erste Zeile geschrieben ist.
   */
  async prepare(
    organizationId: string,
    user: User,
    query: ExportOrdersDto,
  ): Promise<OrdersExport> {
    await this.assertMayExport(organizationId, user.id);

    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: OPERATING_MODE_SELECT,
    });
    const orderOnly = isOrdersOnly(organization);
    const variant = query.variant ?? OrdersExportVariant.ORDERS;

    const qb = this.orderRepository
      .createQueryBuilder('ord')
      .select('ord.id', 'id')
      .where('ord.organizationId = :organizationId', { organizationId });
    this.ordersService.applyOrderFilters(qb, 'ord', query);
    qb.orderBy('ord.createdAt', 'ASC').addOrderBy('ord.id', 'ASC');
    const ids = (await qb.getRawMany<{ id: string }>()).map((r) => r.id);

    const day = localDateKey(new Date());
    const filename =
      variant === OrdersExportVariant.ITEMS
        ? `bestellpositionen_${day}.csv`
        : `bestellungen_${day}.csv`;

    return { filename, chunks: this.chunks(ids, variant, orderOnly) };
  }

  private async *chunks(
    ids: string[],
    variant: OrdersExportVariant,
    orderOnly: boolean,
  ): AsyncGenerator<string> {
    const manager = this.orderRepository.manager;
    if (variant === OrdersExportVariant.ITEMS) {
      const columns = columnsFor(ITEM_COLUMNS, orderOnly);
      yield CSV_BOM + csvHeader(columns.map((c) => c.header));
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const rows = await manager.query<OrderItemExportRow[]>(ITEM_SQL, [
          ids.slice(i, i + BATCH_SIZE),
        ]);
        if (rows.length) yield csvRows(columns, rows, orderOnly);
      }
      return;
    }

    const columns = columnsFor(ORDER_COLUMNS, orderOnly);
    yield CSV_BOM + csvHeader(columns.map((c) => c.header));
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const rows = await manager.query<OrderExportRow[]>(ORDER_SQL, [
        ids.slice(i, i + BATCH_SIZE),
      ]);
      if (rows.length) yield csvRows(columns, rows, orderOnly);
    }
  }

  /** Admin oder Recht „Bestellungen“ — wie Storno und Erstattung. */
  private async assertMayExport(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const member = await this.memberRepository.findOne({
      where: { organizationId, userId },
    });
    if (!member) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.ORGANIZATION_ACCESS_DENIED,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }
    if (
      member.role !== OrganizationRole.ADMIN &&
      member.permissions?.orders !== true
    ) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message:
          'Zum Exportieren der Bestellungen brauchst du das Recht „Bestellungen“ oder Admin.',
      });
    }
  }
}
