import { SERVICE_FEE_TAX_RATE, tipByRate } from '../refunds/refund-calc';

/** § 19 Abs. 1 UStG (ab 2025): Grenzen fuer Kleinunternehmer in Euro. */
export const SMALL_BUSINESS_LIMIT_CURRENT = 100_000;
export const SMALL_BUSINESS_LIMIT_PREVIOUS = 25_000;

export interface SmallBusinessStatus {
  vatExempt: boolean;
  year: number;
  currentYearRevenue: number;
  previousYearRevenue: number;
  limitCurrentYear: number;
  limitPreviousYear: number;
  /** Anteil an 100.000 € (0..n). */
  ratio: number;
  /** Nur fuer Kleinunternehmer: ab 80 % `approaching`, darueber `exceeded`. */
  warning: 'approaching' | 'exceeded' | null;
}
import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  MoreThanOrEqual,
  type ObjectLiteral,
  Repository,
  type SelectQueryBuilder,
} from 'typeorm';
import {
  Order,
  OrderItem,
  Payment,
  Product,
  Category,
  StockMovement,
  PfandReturn,
  UserOrganization,
  User,
  Device,
  Printer,
  PrintJob,
  Organization,
} from '../../database/entities';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { OrderStatus } from '../../database/entities/order.entity';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
import { DeviceType } from '../../database/entities/device.entity';
import { PaymentTransactionStatus } from '../../database/entities/payment.entity';
import { PrintJobStatus } from '../../database/entities/print-job.entity';
import { QueryReportsDto, ReportExportFormat } from './dto';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  OPERATING_MODE_SELECT,
  getOperatingMode,
  type OperatingMode,
} from '../../common/utils/operating-mode.util';
import {
  endOfDay,
  localDateKey,
  startOfDay,
} from '../../common/utils/date-range.util';
import type { PfandReturnLine } from '../../database/entities/pfand-return.entity';
import {
  buildVatReport,
  type RefundCompositionRecord,
  type VatReport,
} from './vat-report';

export interface SalesReport {
  totalRevenue: number;
  totalOrders: number;
  averageOrderValue: number;
  totalItemsSold: number;
  /**
   * Deposits (Pfand) collected with sales — shown apart from revenue
   * (goods). VAT-wise Pfand is part of the consideration: see the VAT
   * report (`getVatReport`).
   */
  pfandCollected: number;
  /** Deposits paid back to guests on return. */
  pfandReturned: number;
  /** pfandCollected − pfandReturned (deposits still out in the wild). */
  pfandBalance: number;
  /** Orders with status CANCELLED, same filters, excluded from totalOrders/totalRevenue. */
  cancelledOrders: number;
  /** cancelledOrders / (totalOrders + cancelledOrders), in percent. */
  cancellationRate: number;
}

export interface ChannelReport {
  channel: string;
  orders: number;
  revenue: number;
  avgReceipt: number;
}

export interface CategoryReport {
  categoryId: string;
  name: string;
  quantity: number;
  revenue: number;
}

export interface DeviceReport {
  deviceId: string;
  name: string;
  orders: number;
  revenue: number;
}

/** Eine Zeile des Berichts „Bedienungen“ (je Bedienung bzw. Mitglied). */
export interface WaiterReportRow {
  kind: 'waiter' | 'member' | 'none';
  waiterId: string | null;
  userId: string | null;
  name: string;
  shortName: string | null;
  color: string | null;
  role: string | null;
  /** Aufgenommen (Ersteller): Bestellungen, Positionen (Runden), Umsatz. */
  orders: number;
  items: number;
  revenue: number;
  /** Kassiert: Anzahl, Summe, je Zahlart, davon Trinkgeld. */
  payments: number;
  collected: number;
  cashAmount: number;
  cardAmount: number;
  otherAmount: number;
  tips: number;
  /** Storno/Erstattungen ausgeloest (Betrag positiv) und Pfand ausgezahlt. */
  refundCount: number;
  refunds: number;
  pfandReturned: number;
  settlements: number;
  openOrders: number;
}

export interface ProductReport {
  productId: string;
  productName: string;
  categoryName: string;
  quantitySold: number;
  revenue: number;
  averagePrice: number;
}

export interface PaymentReport {
  method: string;
  count: number;
  total: number;
  percentage: number;
}

export interface HourlyReport {
  /** Lokales Datum (YYYY-MM-DD) — bei mehrtägigen Veranstaltungen mehrere Tage */
  date: string;
  hour: number;
  orders: number;
  revenue: number;
}

export interface StockMovementReport {
  productId: string;
  productName: string;
  openingStock: number;
  additions: number;
  deductions: number;
  closingStock: number;
}

/**
 * Abgleich der Produkt- und Kategorieberichte mit dem Umsatz netto.
 *
 * Produktzeilen = Warenwert netto: verkauft minus storniert minus
 * erstattete Mengen, nach anteiligem Bestellrabatt, ohne Pfand und
 * Trinkgeld. Was keiner Position gehoert, steht als eigene Zeile:
 *
 *   Summe Produkte + Erstattungen ohne Position + Trinkgeld = Umsatz netto
 *
 * Kulanz-Erstattungen ohne Positionsbezug (freier Betrag) werden bewusst
 * nicht anteilig auf die Produkte verteilt: der Gegenbeleg nennt kein
 * Produkt, eine Verteilung wuerde eine Zuordnung erfinden (5 € Kulanz
 * fuer kalten Kaffee wuerden die Bratwurst mindern) und Mengen liessen
 * sich ohnehin nicht abziehen. Erstattungen nach Positionen mindern
 * dagegen genau das Produkt, Menge und Betrag.
 */
export interface NetSalesSummary {
  /** Warenwert netto aller Positionen (ungerundete Summe, auf Cent). */
  itemsRevenue: number;
  /** Kulanz-Erstattungen ohne Positionsbezug (negativ). */
  unassignedRefunds: number;
  /** Trinkgeld abzueglich erstattetem Trinkgeld. */
  tips: number;
  /** Umsatz netto wie im Verkaufsbericht (`totalRevenue`). */
  netRevenue: number;
}

type CsvZelle = string | number | boolean | null | undefined;

/** Kulanz-Erstattungen je Bestellung (negativ), ohne Pfand. */
export const GOODWILL_NET = `COALESCE((SELECT SUM(rf.amount - rf.pfand_amount) FROM refunds rf WHERE rf.order_id = order.id AND rf.kind = 'refund'), 0)`;
/** Pfandanteil der Kulanz-Erstattungen (negativ). */
const GOODWILL_PFAND = `COALESCE((SELECT SUM(rf.pfand_amount) FROM refunds rf WHERE rf.order_id = order.id AND rf.kind = 'refund'), 0)`;
/** Kulanz-Erstattungen je Bestellung (negativ), inkl. Pfand. */
const GOODWILL_GROSS = `COALESCE((SELECT SUM(rf.amount) FROM refunds rf WHERE rf.order_id = order.id AND rf.kind = 'refund'), 0)`;
/** Warenanteil der Kulanz-Erstattungen (negativ, ohne Pfand und Trinkgeld). */
const GOODWILL_GOODS = `COALESCE((SELECT SUM(rf.amount - rf.pfand_amount - rf.tip_amount) FROM refunds rf WHERE rf.order_id = order.id AND rf.kind = 'refund'), 0)`;
/** Trinkgeldanteil der Kulanz-Erstattungen (negativ). */
const GOODWILL_TIP = `COALESCE((SELECT SUM(rf.tip_amount) FROM refunds rf WHERE rf.order_id = order.id AND rf.kind = 'refund'), 0)`;
/**
 * Anteil des Warenwerts, der nach Rabatt bei der Bestellung bleibt —
 * dieselbe Rechnung wie beim Gegenbeleg (`discountFactor`).
 * `total − Pfand − Trinkgeld` ist der Warenwert nach Rabatt.
 */
const NET_FACTOR = `(CASE WHEN order.subtotal > 0 THEN (order.total - order.pfandTotal - order.tipAmount) / order.subtotal ELSE 0 END)`;
/**
 * Wie `NET_FACTOR`, aber ohne die Servicegebuehr des Shops: fuer die
 * Umsatzsteuer je Satz, in der die Gebuehr eine eigene Zeile mit ihrem
 * Satz ist (`order.serviceFeeTaxRate`). Die Umsatzuebersicht rechnet die
 * Gebuehr weiter anteilig zu den Waren (sie hat dort keine eigene Zeile).
 */
const GOODS_FACTOR = `(CASE WHEN order.subtotal > 0 THEN (order.total - order.pfandTotal - order.tipAmount - order.serviceFee) / order.subtotal ELSE 0 END)`;
/** Noch nicht erstatteter Anteil einer Position (Kulanz nach Positionen). */
const OPEN_SHARE = `(CASE WHEN item.quantity > 0 THEN CAST(item.quantity - item.refundedQuantity AS numeric) / item.quantity ELSE 0 END)`;
/** Erstatteter Anteil einer Position. */
const REFUNDED_SHARE = `(CASE WHEN item.quantity > 0 THEN CAST(item.refundedQuantity AS numeric) / item.quantity ELSE 0 END)`;
/** Warenwert netto einer Position (Rabatt anteilig, erstattete Menge ab). */
export const ITEM_NET_REVENUE = `(item.totalPrice * ${OPEN_SHARE} * ${NET_FACTOR})`;
/** Verkaufte Menge netto (erstattete Menge ab). */
export const ITEM_NET_QUANTITY = `(item.quantity - item.refundedQuantity)`;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Geldspalten der Berichte. In der Betriebsart „Nur Bons“ (`orders_only`)
 * kassiert OpenEOS nicht und zeigt keine Preise — Berichte enthalten dann
 * nur Mengen (Bestellungen, Positionen, Stueckzahlen).
 */
export const REPORT_MONEY_KEYS = new Set([
  'revenue',
  'totalRevenue',
  'netRevenue',
  'itemsRevenue',
  'avgReceipt',
  'averagePrice',
  'averageOrderValue',
  'averageReceipt',
  'orderValue',
  'tips',
  'amount',
  'total',
  'tax',
  'taxTotal',
  'pfandCollected',
  'pfandReturned',
  'pfandBalance',
  'goods',
  'deposits',
  'depositReturns',
  'gross',
  'net',
  'goodwillGoods',
  'attributedRefunds',
  'unassignedRefunds',
  'refunds',
  'collected',
  'cashAmount',
  'cardAmount',
  'otherAmount',
  'percentage',
]);

/** Berichtswerte ohne Geldspalten (rekursiv), fuer `orders_only`. */
export function countsOnly<T>(value: T): T {
  if (Array.isArray(value)) {
    return (value as unknown[]).map((v) => countsOnly(v)) as T;
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (REPORT_MONEY_KEYS.has(key)) continue;
      out[key] = countsOnly(v);
    }
    return out as T;
  }
  return value;
}

/** Erstattungen je Zahlung (negativ, alle Arten — Geldfluss). */
export const PAYMENT_REFUNDS = `COALESCE((SELECT SUM(rf.amount) FROM refunds rf WHERE rf.payment_id = payment.id), 0)`;
/** Erstattetes Geld einer Zahlung (ohne zurueckgegebene Wertmarken). */
export const PAYMENT_MONEY_REFUNDS = `COALESCE((SELECT SUM(rf.amount) FROM refunds rf WHERE rf.payment_id = payment.id AND rf.payment_method <> 'tokens'), 0)`;
/** Bei Storno/Erstattung zurueckgegebene Wertmarken einer Zahlung (negativ). */
export const PAYMENT_TOKEN_REFUNDS = `COALESCE((SELECT SUM(rf.amount) FROM refunds rf WHERE rf.payment_id = payment.id AND rf.payment_method = 'tokens'), 0)`;

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepository: Repository<OrderItem>,
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(StockMovement)
    private readonly stockMovementRepository: Repository<StockMovement>,
    @InjectRepository(PfandReturn)
    private readonly pfandReturnRepository: Repository<PfandReturn>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Printer)
    private readonly printerRepository: Repository<Printer>,
    @InjectRepository(PrintJob)
    private readonly printJobRepository: Repository<PrintJob>,
    private readonly configService: ConfigService,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
  ) {}

  /**
   * Betriebsart der Organisation. In `orders_only` („Nur Bons“) kassiert
   * OpenEOS nicht und zeigt keine Preise: Export und Agenten-Werkzeug
   * liefern dann nur Mengen (`countsOnly`), die Oberflaeche ebenso.
   */
  async getOperatingMode(organizationId: string): Promise<OperatingMode> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: OPERATING_MODE_SELECT,
    });
    return getOperatingMode(organization);
  }

  /**
   * Zeitzone für stundenbasierte Auswertungen. created_at ist timestamptz —
   * ohne Konvertierung liefert EXTRACT(HOUR ...) die UTC-Stunde und der
   * Stundenverlauf ist in Deutschland um 1-2 Stunden verschoben.
   * Wert wird gegen eine Whitelist geprüft, da er in SQL eingebettet wird.
   */
  private reportTimeZone(): string {
    const tz =
      this.configService.get<string>('REPORT_TIMEZONE') || 'Europe/Berlin';
    return /^[A-Za-z0-9_+/-]+$/.test(tz) ? tz : 'Europe/Berlin';
  }

  /** Veranstaltung und Zeitraum (Bestelldatum), wie in allen Umsatzberichten. */
  private applyOrderFilters<T extends ObjectLiteral>(
    queryBuilder: SelectQueryBuilder<T>,
    { eventId, startDate, endDate }: QueryReportsDto,
  ): SelectQueryBuilder<T> {
    if (eventId) {
      queryBuilder.andWhere('order.eventId = :eventId', { eventId });
    }
    if (startDate && endDate) {
      queryBuilder.andWhere('order.createdAt BETWEEN :startDate AND :endDate', {
        startDate: startOfDay(startDate),
        endDate: endOfDay(endDate),
      });
    } else if (startDate) {
      queryBuilder.andWhere('order.createdAt >= :startDate', {
        startDate: startOfDay(startDate),
      });
    } else if (endDate) {
      queryBuilder.andWhere('order.createdAt <= :endDate', {
        endDate: endOfDay(endDate),
      });
    }
    return queryBuilder;
  }

  /** Positionen nicht stornierter Bestellungen, ohne stornierte Positionen. */
  private soldItemsQuery(organizationId: string, queryDto: QueryReportsDto) {
    const queryBuilder = this.orderItemRepository
      .createQueryBuilder('item')
      .innerJoin('item.order', 'order')
      .where('order.organizationId = :organizationId', { organizationId })
      .andWhere('order.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: [OrderStatus.CANCELLED],
      })
      .andWhere('item.status <> :cancelledItem', {
        cancelledItem: OrderItemStatus.CANCELLED,
      });
    return this.applyOrderFilters(queryBuilder, queryDto);
  }

  async getSalesReport(
    organizationId: string,
    queryDto: QueryReportsDto,
    user: User,
  ): Promise<SalesReport> {
    await this.checkPermission(organizationId, user.id);
    const { eventId, startDate, endDate } = queryDto;

    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .where('order.organizationId = :organizationId', { organizationId })
      .andWhere('order.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: [OrderStatus.CANCELLED],
      });

    if (eventId) {
      queryBuilder.andWhere('order.eventId = :eventId', { eventId });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('order.createdAt BETWEEN :startDate AND :endDate', {
        startDate: startOfDay(startDate),
        endDate: endOfDay(endDate),
      });
    } else if (startDate) {
      queryBuilder.andWhere('order.createdAt >= :startDate', {
        startDate: startOfDay(startDate),
      });
    } else if (endDate) {
      queryBuilder.andWhere('order.createdAt <= :endDate', {
        endDate: endOfDay(endDate),
      });
    }

    const result = await queryBuilder
      .select([
        // Revenue = goods (+ tips); Pfand is shown separately (and with its
        // VAT rate in the VAT report).
        // Aliases are quoted so Postgres preserves their camelCase.
        // Kulanz-Erstattungen (Gegenbelege ohne Storno) mindern den Umsatz;
        // Storno-Erstattungen stecken schon in der gesunkenen Summe.
        `SUM(order.total - order.pfandTotal + ${GOODWILL_NET}) as "totalRevenue"`,
        'COUNT(order.id) as "totalOrders"',
        `AVG(order.total - order.pfandTotal + ${GOODWILL_NET}) as "averageOrderValue"`,
        `SUM(order.pfandTotal + ${GOODWILL_PFAND}) as "pfandCollected"`,
      ])
      .getRawOne<{
        totalRevenue: string | null;
        totalOrders: string | null;
        averageOrderValue: string | null;
        pfandCollected: string | null;
      }>();

    // Deposits paid back to guests (separate ledger), same time/event filter.
    const returnsQb = this.pfandReturnRepository
      .createQueryBuilder('ret')
      .where('ret.organizationId = :organizationId', { organizationId });
    if (eventId) {
      returnsQb.andWhere('ret.eventId = :eventId', { eventId });
    }
    if (startDate && endDate) {
      returnsQb.andWhere('ret.createdAt BETWEEN :startDate AND :endDate', {
        startDate: startOfDay(startDate),
        endDate: endOfDay(endDate),
      });
    } else if (startDate) {
      returnsQb.andWhere('ret.createdAt >= :startDate', {
        startDate: startOfDay(startDate),
      });
    } else if (endDate) {
      returnsQb.andWhere('ret.createdAt <= :endDate', {
        endDate: endOfDay(endDate),
      });
    }
    const returnsResult = await returnsQb
      .select('SUM(ret.totalAmount)', 'pfandReturned')
      .getRawOne<{ pfandReturned: string | null }>();

    // Verkaufte Artikel netto: ohne stornierte Positionen, erstattete
    // Mengen ab — dieselbe Menge wie im Produktbericht.
    const itemsResult = await this.soldItemsQuery(organizationId, queryDto)
      .select(`SUM(${ITEM_NET_QUANTITY})`, 'totalItems')
      .getRawOne<{ totalItems: string | null }>();

    // Cancelled orders, same filters — mirrors the queries above but flips
    // the status filter instead of excluding CANCELLED.
    const cancelledQueryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .where('order.organizationId = :organizationId', { organizationId })
      .andWhere('order.status = :cancelledStatus', {
        cancelledStatus: OrderStatus.CANCELLED,
      });

    if (eventId) {
      cancelledQueryBuilder.andWhere('order.eventId = :eventId', { eventId });
    }

    if (startDate && endDate) {
      cancelledQueryBuilder.andWhere(
        'order.createdAt BETWEEN :startDate AND :endDate',
        {
          startDate: startOfDay(startDate),
          endDate: endOfDay(endDate),
        },
      );
    } else if (startDate) {
      cancelledQueryBuilder.andWhere('order.createdAt >= :startDate', {
        startDate: startOfDay(startDate),
      });
    } else if (endDate) {
      cancelledQueryBuilder.andWhere('order.createdAt <= :endDate', {
        endDate: endOfDay(endDate),
      });
    }

    const cancelledCount = await cancelledQueryBuilder.getCount();

    const pfandCollected = Number(result?.pfandCollected || 0);
    const pfandReturned = Number(returnsResult?.pfandReturned || 0);
    const totalOrders = Number(result?.totalOrders || 0);
    const totalConsidered = totalOrders + cancelledCount;

    return {
      totalRevenue: Number(result?.totalRevenue || 0),
      totalOrders,
      averageOrderValue: Number(result?.averageOrderValue || 0),
      totalItemsSold: Number(itemsResult?.totalItems || 0),
      pfandCollected,
      pfandReturned,
      pfandBalance: pfandCollected - pfandReturned,
      cancelledOrders: cancelledCount,
      cancellationRate:
        totalConsidered > 0 ? (cancelledCount / totalConsidered) * 100 : 0,
    };
  }

  /**
   * Produkte netto: verkaufte Menge minus storniert und erstattet, Umsatz
   * als Warenwert nach anteiligem Rabatt, ohne Pfand und Trinkgeld.
   * Kulanz ohne Positionsbezug und Trinkgeld stehen im Abgleich
   * (`getNetSalesSummary`), nicht in den Zeilen.
   */
  async getProductsReport(
    organizationId: string,
    queryDto: QueryReportsDto,
    user: User,
  ): Promise<ProductReport[]> {
    await this.checkPermission(organizationId, user.id);

    const results = await this.soldItemsQuery(organizationId, queryDto)
      // Quote the aliases — Postgres folds unquoted identifiers to lower case,
      // so getRawMany() would return `productname`/`quantitysold` and the
      // camelCase mapping below would read undefined (empty product, qty 0).
      .select([
        'item.productId as "productId"',
        'item.productName as "productName"',
        'item.categoryName as "categoryName"',
        `SUM(${ITEM_NET_QUANTITY}) as "quantitySold"`,
        `SUM(${ITEM_NET_REVENUE}) as "revenue"`,
        'AVG(item.unitPrice) as "averagePrice"',
      ])
      .groupBy('item.productId')
      .addGroupBy('item.productName')
      .addGroupBy('item.categoryName')
      // Top-Produkte nach verkaufter Menge (bei Gleichstand nach Umsatz)
      .orderBy(`SUM(${ITEM_NET_QUANTITY})`, 'DESC')
      .addOrderBy(`SUM(${ITEM_NET_REVENUE})`, 'DESC')
      .getRawMany<{
        productId: string;
        productName: string;
        categoryName: string;
        quantitySold: string | null;
        revenue: string | null;
        averagePrice: string | null;
      }>();

    return results.map((r) => ({
      productId: r.productId,
      productName: r.productName,
      categoryName: r.categoryName,
      quantitySold: Number(r.quantitySold || 0),
      revenue: round2(Number(r.revenue || 0)),
      averagePrice: Number(r.averagePrice || 0),
    }));
  }

  /**
   * Abgleich Produkte/Kategorien ↔ Umsatz netto (siehe `NetSalesSummary`).
   * Gleiche Filter wie die Berichte; Erstattungen zaehlen zur Bestellung
   * (Bestelldatum), wie im Verkaufsbericht.
   */
  async getNetSalesSummary(
    organizationId: string,
    queryDto: QueryReportsDto,
    user: User,
  ): Promise<NetSalesSummary> {
    await this.checkPermission(organizationId, user.id);

    const ordersQb = this.orderRepository
      .createQueryBuilder('order')
      .where('order.organizationId = :organizationId', { organizationId })
      .andWhere('order.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: [OrderStatus.CANCELLED],
      });
    const orderTotals = await this.applyOrderFilters(ordersQb, queryDto)
      .select([
        `SUM(order.total - order.pfandTotal + ${GOODWILL_NET}) as "netRevenue"`,
        `SUM(order.tipAmount + ${GOODWILL_TIP}) as "tips"`,
        `SUM(${GOODWILL_GOODS}) as "goodwillGoods"`,
      ])
      .getRawOne<{
        netRevenue: string | null;
        tips: string | null;
        goodwillGoods: string | null;
      }>();

    const itemTotals = await this.soldItemsQuery(organizationId, queryDto)
      .select([
        `SUM(${ITEM_NET_REVENUE}) as "itemsRevenue"`,
        `SUM(item.totalPrice * ${REFUNDED_SHARE} * ${NET_FACTOR}) as "attributed"`,
      ])
      .getRawOne<{ itemsRevenue: string | null; attributed: string | null }>();

    return netSalesSummary({
      netRevenue: Number(orderTotals?.netRevenue || 0),
      tips: Number(orderTotals?.tips || 0),
      goodwillGoods: Number(orderTotals?.goodwillGoods || 0),
      itemsRevenue: Number(itemTotals?.itemsRevenue || 0),
      attributedRefunds: Number(itemTotals?.attributed || 0),
    });
  }

  /**
   * Umsatz und Umsatzsteuer je Steuersatz (siehe `buildVatReport`): Ware
   * und Pfand aus nicht stornierten Bestellungen (Bestelldatum, Rabatt
   * anteilig auf die Ware), Kulanz-Erstattungen dieser Bestellungen ab,
   * Pfand-Rueckgaben im Zeitraum negativ beim Satz ihrer Pfandart.
   * Gespeicherte Saetze sind Snapshots: alte Buchungen bleiben, wie sie
   * waren (Pfand ohne Satz = 0 %).
   */
  async getVatReport(
    organizationId: string,
    queryDto: QueryReportsDto,
    user: User,
  ): Promise<VatReport> {
    await this.checkPermission(organizationId, user.id);
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: { id: true, settings: true },
    });
    const vatExempt = organization?.settings?.vatExempt !== false;

    const goodsRows = await this.soldItemsQuery(organizationId, queryDto)
      .select('item.taxRate', 'rate')
      .addSelect(`SUM(item.totalPrice * ${GOODS_FACTOR})`, 'gross')
      .groupBy('item.taxRate')
      .getRawMany<{ rate: string; gross: string | null }>();
    // Servicegebuehr des Shops: eigene Leistung mit ihrem Satz.
    const feeQb = this.orderRepository
      .createQueryBuilder('order')
      .select(
        `COALESCE(order.serviceFeeTaxRate, ${SERVICE_FEE_TAX_RATE})`,
        'rate',
      )
      .addSelect('SUM(order.serviceFee)', 'gross')
      .where('order.organizationId = :organizationId', { organizationId })
      .andWhere('order.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: [OrderStatus.CANCELLED],
      })
      .andWhere('order.serviceFee <> 0');
    this.applyOrderFilters(feeQb, queryDto);
    const feeRows = await feeQb
      .groupBy(`COALESCE(order.serviceFeeTaxRate, ${SERVICE_FEE_TAX_RATE})`)
      .getRawMany<{ rate: string; gross: string | null }>();
    const depositRows = await this.soldItemsQuery(organizationId, queryDto)
      .select('COALESCE(item.depositTaxRate, 0)', 'rate')
      .addSelect('SUM(item.depositAmount * item.quantity)', 'gross')
      .andWhere('item.depositAmount <> 0')
      .groupBy('COALESCE(item.depositTaxRate, 0)')
      .getRawMany<{ rate: string; gross: string | null }>();
    const toMap = (rows: { rate: string; gross: string | null }[]) =>
      new Map(
        rows.map((r) => [
          Number(r.rate) || 0,
          Math.round(Number(r.gross || 0) * 100),
        ]),
      );

    // Kulanz-Erstattungen (ohne Storno) der Bestellungen im Bericht.
    const ordersQb = this.orderRepository
      .createQueryBuilder('order')
      .select('order.id', 'id')
      .where('order.organizationId = :organizationId', { organizationId })
      .andWhere('order.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: [OrderStatus.CANCELLED],
      });
    this.applyOrderFilters(ordersQb, queryDto);
    const refundRows = await this.orderRepository.manager
      .createQueryBuilder()
      .select('rf.metadata', 'metadata')
      .from('refunds', 'rf')
      .where(`rf.order_id IN (${ordersQb.getQuery()})`)
      .andWhere(`rf.kind = 'refund'`)
      .setParameters(ordersQb.getParameters())
      .getRawMany<{ metadata: Record<string, unknown> | null }>();

    const returnsQb = this.pfandReturnRepository
      .createQueryBuilder('ret')
      .select('ret.lines', 'lines')
      .where('ret.organizationId = :organizationId', { organizationId });
    this.applyReturnFilters(returnsQb, queryDto);
    const returnRows = await returnsQb.getRawMany<{
      lines: PfandReturnLine[] | null;
    }>();

    // Trinkgeld je Bestellung: an den Verein (abzgl. Kulanz-Erstattungen und
    // Trinkgeld angestellter Bedienungen) anteilig auf die Warensaetze.
    const tipRows = await this.soldItemsQuery(organizationId, queryDto)
      .select('order.id', 'orderId')
      .addSelect('item.taxRate', 'rate')
      .addSelect(`SUM(item.totalPrice * ${GOODS_FACTOR})`, 'gross')
      .addSelect(`MAX(order.tipAmount + ${GOODWILL_TIP})`, 'tip')
      .addSelect(
        `MAX(COALESCE((SELECT SUM(p.tip_amount) FROM payments p JOIN waiters w ON w.id = p.processed_by_waiter_id
            WHERE p.order_id = order.id AND w.is_employee AND p.status IN ('captured', 'refunded')), 0))`,
        'employeeTip',
      )
      .andWhere('order.tipAmount <> 0')
      .groupBy('order.id')
      .addGroupBy('item.taxRate')
      .getRawMany<{
        orderId: string;
        rate: string;
        gross: string | null;
        tip: string | null;
        employeeTip: string | null;
      }>();
    const tipOrders = new Map<
      string,
      { goods: Map<number, number>; tip: number; employee: number }
    >();
    for (const row of tipRows) {
      const entry = tipOrders.get(row.orderId) ?? {
        goods: new Map<number, number>(),
        tip: Math.round(Number(row.tip || 0) * 100),
        employee: Math.round(Number(row.employeeTip || 0) * 100),
      };
      entry.goods.set(
        Number(row.rate) || 0,
        Math.round(Number(row.gross || 0) * 100),
      );
      tipOrders.set(row.orderId, entry);
    }
    const clubByRate = new Map<number, number>();
    let employeeCents = 0;
    for (const entry of tipOrders.values()) {
      const employee = Math.min(Math.max(entry.employee, 0), entry.tip);
      employeeCents += employee;
      for (const [rate, value] of tipByRate(
        entry.goods,
        entry.tip - employee,
      )) {
        clubByRate.set(rate, (clubByRate.get(rate) ?? 0) + value);
      }
    }

    const tokens = await this.vatTokenFigures(
      organizationId,
      queryDto,
      vatExempt,
    );

    return buildVatReport({
      vatExempt,
      tips: { clubByRate, employeeCents },
      tokens,
      sales: {
        goodsByRate: addRateMaps(toMap(goodsRows), toMap(feeRows)),
        depositsByRate: toMap(depositRows),
      },
      goodwillRefunds: refundRows.map(
        (r) =>
          (r.metadata?.composition as RefundCompositionRecord | undefined) ??
          null,
      ),
      pfandReturnLines: returnRows.flatMap((r) => r.lines ?? []),
    });
  }

  /**
   * Wertmarken fuer den Bericht „Umsatzsteuer“ (Cent):
   * - Einzweckgutschein je Satz: Verkauf (+) und Ruecktausch (−) im
   *   Zeitraum/der Veranstaltung der Buchung; Einloesung (−) und Rueckgabe
   *   bei Storno/Erstattung (+) wie die Ware nach Bestelldatum — die
   *   eingeloeste Ware steht in `goods`, ihre Steuer entstand beim Verkauf.
   * - Mehrzweckgutschein nachrichtlich (nicht steuerbar).
   * Kleinunternehmer buchen alles als Mehrzweck.
   */
  private async vatTokenFigures(
    organizationId: string,
    queryDto: QueryReportsDto,
    vatExempt: boolean,
  ): Promise<{
    singlePurposeByRate: Map<number, number>;
    multiPurposeSoldCents: number;
    multiPurposeBoughtBackCents: number;
  }> {
    const { eventId, startDate, endDate } = queryDto;
    const filters = (
      eventColumn: string,
      dateColumn: string,
      params: unknown[],
    ) => {
      const where: string[] = [];
      if (eventId) {
        params.push(eventId);
        where.push(`${eventColumn} = $${params.length}`);
      }
      if (startDate) {
        params.push(startOfDay(startDate));
        where.push(`${dateColumn} >= $${params.length}`);
      }
      if (endDate) {
        params.push(endOfDay(endDate));
        where.push(`${dateColumn} <= $${params.length}`);
      }
      return where.length ? ` AND ${where.join(' AND ')}` : '';
    };
    const txParams: unknown[] = [organizationId];
    const txRows = await this.orderRepository.manager.query<
      { kind: string; lkind: string; rate: string | null; amount: string }[]
    >(
      `SELECT t.kind, l->>'kind' AS lkind, l->>'vatRate' AS rate,
              COALESCE(SUM(abs((l->>'amount')::numeric)), 0) AS amount
         FROM token_transactions t
         CROSS JOIN LATERAL jsonb_array_elements(t.lines) l
        WHERE t.organization_id = $1 AND t.is_test = false${filters('t.event_id', 't.created_at', txParams)}
        GROUP BY 1, 2, 3`,
      txParams,
    );
    const redParams: unknown[] = [organizationId];
    const orderFilter = filters('o.event_id', 'o.created_at', redParams);
    const redeemedRows = await this.orderRepository.manager.query<
      { source: string; rate: string | null; amount: string }[]
    >(
      `SELECT 'redeemed' AS source, l->>'vatRate' AS rate,
              COALESCE(SUM((l->>'amount')::numeric), 0) AS amount
         FROM payments p
         JOIN orders o ON o.id = p.order_id
         CROSS JOIN LATERAL jsonb_array_elements(p.token_lines) l
        WHERE o.organization_id = $1 AND o.is_test = false AND o.status <> 'cancelled'
          AND p.status IN ('captured', 'refunded') AND l->>'kind' = 'single_purpose'${orderFilter}
        GROUP BY 1, 2
       UNION ALL
       SELECT 'returned', l->>'vatRate',
              COALESCE(SUM(abs((l->>'amount')::numeric)), 0)
         FROM refunds r
         JOIN orders o ON o.id = r.order_id
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.metadata->'tokenLines', '[]'::jsonb)) l
        WHERE o.organization_id = $1 AND r.is_test = false AND o.status <> 'cancelled'
          AND r.payment_method = 'tokens' AND l->>'kind' = 'single_purpose'${orderFilter}
        GROUP BY 1, 2`,
      redParams,
    );
    const singlePurposeByRate = new Map<number, number>();
    const addRate = (rate: string | null, value: number) => {
      const r = Number(rate) || 0;
      singlePurposeByRate.set(r, (singlePurposeByRate.get(r) ?? 0) + value);
    };
    let multiPurposeSoldCents = 0;
    let multiPurposeBoughtBackCents = 0;
    for (const row of txRows) {
      const value = Math.round(Number(row.amount) * 100);
      const single = row.lkind === 'single_purpose' && !vatExempt;
      if (!single) {
        if (row.kind === 'sale') multiPurposeSoldCents += value;
        else multiPurposeBoughtBackCents -= value;
        continue;
      }
      addRate(row.rate, row.kind === 'sale' ? value : -value);
    }
    if (!vatExempt) {
      for (const row of redeemedRows) {
        const value = Math.round(Number(row.amount) * 100);
        addRate(row.rate, row.source === 'redeemed' ? -value : value);
      }
    }
    return {
      singlePurposeByRate,
      multiPurposeSoldCents,
      multiPurposeBoughtBackCents,
    };
  }

  /**
   * Kleinunternehmer-Grenzen (§ 19 Abs. 1 UStG seit 2025: 25.000 € im
   * Vorjahr, 100.000 € im laufenden Jahr; schon der Umsatz, mit dem die
   * 100.000 € ueberschritten werden, ist steuerpflichtig). Umsatz in
   * OpenEOS = Zahlungen (ohne Test) − Erstattungen − Pfand-Auszahlungen je
   * Kalenderjahr (Berlin); Pfand und Trinkgeld an den Verein zaehlen zum
   * Gesamtumsatz. Fuer die Warnung im Dashboard (Steuerberater 2026-11-10,
   * Frage 9).
   */
  async getSmallBusinessStatus(
    organizationId: string,
    user: User,
    now: Date = new Date(),
  ): Promise<SmallBusinessStatus> {
    await this.checkPermission(organizationId, user.id);
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: { id: true, settings: true },
    });
    const year = Number(
      new Intl.DateTimeFormat('en', {
        timeZone: 'Europe/Berlin',
        year: 'numeric',
      }).format(now),
    );
    const [row] = await this.orderRepository.manager.query<
      { current: string | null; previous: string | null }[]
    >(
      `WITH moves AS (
         SELECT p.created_at AS at, p.amount + p.token_amount AS amount
           FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE o.organization_id = $1 AND o.is_test = false
            AND p.status IN ('captured', 'refunded')
         UNION ALL
         SELECT r.created_at, r.amount FROM refunds r
          WHERE r.organization_id = $1 AND COALESCE(r.is_test, false) = false
            AND r.status <> 'test'
         UNION ALL
         SELECT pr.created_at, -pr.total_amount FROM pfand_returns pr
          WHERE pr.organization_id = $1 AND pr.is_test = false
       )
       SELECT
         COALESCE(SUM(amount) FILTER (WHERE date_part('year', at AT TIME ZONE 'Europe/Berlin') = $2), 0) AS current,
         COALESCE(SUM(amount) FILTER (WHERE date_part('year', at AT TIME ZONE 'Europe/Berlin') = $2 - 1), 0) AS previous
         FROM moves`,
      [organizationId, year],
    );
    const current = Math.round(Number(row?.current ?? 0) * 100) / 100;
    const previous = Math.round(Number(row?.previous ?? 0) * 100) / 100;
    const vatExempt = organization?.settings?.vatExempt !== false;
    let warning: SmallBusinessStatus['warning'] = null;
    if (vatExempt) {
      if (
        current > SMALL_BUSINESS_LIMIT_CURRENT ||
        previous > SMALL_BUSINESS_LIMIT_PREVIOUS
      )
        warning = 'exceeded';
      else if (current >= SMALL_BUSINESS_LIMIT_CURRENT * 0.8)
        warning = 'approaching';
    }
    return {
      vatExempt,
      year,
      currentYearRevenue: current,
      previousYearRevenue: previous,
      limitCurrentYear: SMALL_BUSINESS_LIMIT_CURRENT,
      limitPreviousYear: SMALL_BUSINESS_LIMIT_PREVIOUS,
      ratio: Math.round((current / SMALL_BUSINESS_LIMIT_CURRENT) * 1000) / 1000,
      warning,
    };
  }

  /** Veranstaltung und Zeitraum fuer Pfand-Auszahlungen (Auszahlungsdatum). */
  private applyReturnFilters(
    queryBuilder: SelectQueryBuilder<PfandReturn>,
    { eventId, startDate, endDate }: QueryReportsDto,
  ): void {
    if (eventId) {
      queryBuilder.andWhere('ret.eventId = :eventId', { eventId });
    }
    if (startDate && endDate) {
      queryBuilder.andWhere('ret.createdAt BETWEEN :startDate AND :endDate', {
        startDate: startOfDay(startDate),
        endDate: endOfDay(endDate),
      });
    } else if (startDate) {
      queryBuilder.andWhere('ret.createdAt >= :startDate', {
        startDate: startOfDay(startDate),
      });
    } else if (endDate) {
      queryBuilder.andWhere('ret.createdAt <= :endDate', {
        endDate: endOfDay(endDate),
      });
    }
  }

  async getPaymentsReport(
    organizationId: string,
    queryDto: QueryReportsDto,
    user: User,
  ): Promise<PaymentReport[]> {
    await this.checkPermission(organizationId, user.id);
    const { eventId, startDate, endDate } = queryDto;

    const queryBuilder = this.paymentRepository
      .createQueryBuilder('payment')
      .innerJoin('payment.order', 'order')
      .where('order.organizationId = :organizationId', { organizationId })
      // Only money that actually arrived — pending/failed payments would
      // inflate the breakdown (same rule as the device revenue stats).
      // Erstattete Zahlungen zaehlen mit, die Erstattungen werden abgezogen.
      .andWhere('payment.status IN (:...paymentStatuses)', {
        paymentStatuses: [
          PaymentTransactionStatus.CAPTURED,
          PaymentTransactionStatus.REFUNDED,
        ],
      });

    if (eventId) {
      queryBuilder.andWhere('order.eventId = :eventId', { eventId });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere(
        'payment.createdAt BETWEEN :startDate AND :endDate',
        {
          startDate: startOfDay(startDate),
          endDate: endOfDay(endDate),
        },
      );
    }

    const results = await queryBuilder
      .select([
        // Entity property is paymentMethod (column payment_method)
        'payment.paymentMethod as method',
        'COUNT(payment.id) as count',
        `SUM(payment.amount + ${PAYMENT_MONEY_REFUNDS}) as total`,
        // Wertmarken: eigener Posten ueber alle Zahlungen (auch Bar + Marken).
        `COUNT(payment.id) FILTER (WHERE payment.token_amount > 0) as "tokenCount"`,
        `SUM(payment.token_amount + ${PAYMENT_TOKEN_REFUNDS}) as "tokenTotal"`,
      ])
      .groupBy('payment.paymentMethod')
      .getRawMany<{
        method: string;
        count: string | null;
        total: string | null;
        tokenCount: string | null;
        tokenTotal: string | null;
      }>();

    // Zahlungen nur mit Marken haben kein Geld: sie zaehlen im Posten
    // „Wertmarken“, der den Markenwert aller Zahlungen traegt.
    const tokenCount = results.reduce(
      (sum, r) => sum + Number(r.tokenCount || 0),
      0,
    );
    const tokenTotal =
      Math.round(
        results.reduce((sum, r) => sum + Number(r.tokenTotal || 0), 0) * 100,
      ) / 100;
    const merged = results
      .filter((r) => r.method !== 'tokens')
      .map((r) => ({ method: r.method, count: r.count, total: r.total }));
    if (tokenCount > 0) {
      merged.push({
        method: 'tokens',
        count: String(tokenCount),
        total: String(tokenTotal),
      });
    }

    const grandTotal = merged.reduce((sum, r) => sum + Number(r.total || 0), 0);

    return merged.map((r) => ({
      method: r.method,
      count: Number(r.count || 0),
      total: Number(r.total || 0),
      percentage:
        grandTotal > 0 ? (Number(r.total || 0) / grandTotal) * 100 : 0,
    }));
  }

  async getHourlyReport(
    organizationId: string,
    queryDto: QueryReportsDto,
    user: User,
  ): Promise<HourlyReport[]> {
    await this.checkPermission(organizationId, user.id);
    const { eventId, startDate, endDate } = queryDto;

    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .where('order.organizationId = :organizationId', { organizationId })
      .andWhere('order.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: [OrderStatus.CANCELLED],
      });

    if (eventId) {
      queryBuilder.andWhere('order.eventId = :eventId', { eventId });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('order.createdAt BETWEEN :startDate AND :endDate', {
        startDate: startOfDay(startDate),
        endDate: endOfDay(endDate),
      });
    }

    const tz = this.reportTimeZone();
    const localTs = `order.createdAt AT TIME ZONE '${tz}'`;
    const localDate = `to_char((${localTs})::date, 'YYYY-MM-DD')`;
    const localHour = `EXTRACT(HOUR FROM ${localTs})`;
    const results = await queryBuilder
      .select([
        `${localDate} as date`,
        `${localHour} as hour`,
        'COUNT(order.id) as orders',
        `SUM(order.total + ${GOODWILL_GROSS}) as revenue`,
      ])
      .groupBy(localDate)
      .addGroupBy(localHour)
      .orderBy('date', 'ASC')
      .addOrderBy('hour', 'ASC')
      .getRawMany<{
        date: string;
        hour: string;
        orders: string | null;
        revenue: string | null;
      }>();

    // Pro vorkommendem Tag alle 24 Stunden auffüllen (getrennt je Tag —
    // mehrtägige Veranstaltungen sollen nicht in einen 24h-Topf fallen).
    const byDate = new Map<
      string,
      Map<number, { orders: number; revenue: number }>
    >();
    for (const r of results) {
      const date = String(r.date);
      if (!byDate.has(date)) byDate.set(date, new Map());
      byDate.get(date)!.set(Number(r.hour), {
        orders: Number(r.orders || 0),
        revenue: Number(r.revenue || 0),
      });
    }

    // Kein Umsatz → leerer Bericht (ein Tag mit Nullwerten wäre irreführend)
    const hourlyData: HourlyReport[] = [];
    for (const date of Array.from(byDate.keys()).sort()) {
      const hours = byDate.get(date)!;
      for (let h = 0; h < 24; h++) {
        const found = hours.get(h);
        hourlyData.push({
          date,
          hour: h,
          orders: found?.orders ?? 0,
          revenue: found?.revenue ?? 0,
        });
      }
    }

    return hourlyData;
  }

  async getChannelsReport(
    organizationId: string,
    queryDto: QueryReportsDto,
    user: User,
  ): Promise<ChannelReport[]> {
    await this.checkPermission(organizationId, user.id);
    const { eventId, startDate, endDate } = queryDto;

    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .where('order.organizationId = :organizationId', { organizationId })
      .andWhere('order.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: [OrderStatus.CANCELLED],
      });

    if (eventId) {
      queryBuilder.andWhere('order.eventId = :eventId', { eventId });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('order.createdAt BETWEEN :startDate AND :endDate', {
        startDate: startOfDay(startDate),
        endDate: endOfDay(endDate),
      });
    } else if (startDate) {
      queryBuilder.andWhere('order.createdAt >= :startDate', {
        startDate: startOfDay(startDate),
      });
    } else if (endDate) {
      queryBuilder.andWhere('order.createdAt <= :endDate', {
        endDate: endOfDay(endDate),
      });
    }

    const results = await queryBuilder
      .select([
        'order.source as channel',
        'COUNT(order.id) as orders',
        // Revenue excludes Pfand, same convention as getSalesReport.
        `SUM(order.total - order.pfandTotal + ${GOODWILL_NET}) as revenue`,
      ])
      .groupBy('order.source')
      .orderBy(`SUM(order.total - order.pfandTotal + ${GOODWILL_NET})`, 'DESC')
      .getRawMany<{
        channel: string;
        orders: string | null;
        revenue: string | null;
      }>();

    return results.map((r) => {
      const orders = Number(r.orders || 0);
      const revenue = Number(r.revenue || 0);
      return {
        channel: r.channel,
        orders,
        revenue,
        avgReceipt: orders > 0 ? revenue / orders : 0,
      };
    });
  }

  /** Kategorien netto — gleiche Rechnung wie der Produktbericht. */
  async getCategoriesReport(
    organizationId: string,
    queryDto: QueryReportsDto,
    user: User,
  ): Promise<CategoryReport[]> {
    await this.checkPermission(organizationId, user.id);

    const results = await this.soldItemsQuery(organizationId, queryDto)
      .select([
        'item.categoryId as "categoryId"',
        'item.categoryName as "name"',
        `SUM(${ITEM_NET_QUANTITY}) as "quantity"`,
        `SUM(${ITEM_NET_REVENUE}) as "revenue"`,
      ])
      .groupBy('item.categoryId')
      .addGroupBy('item.categoryName')
      .orderBy(`SUM(${ITEM_NET_REVENUE})`, 'DESC')
      .getRawMany<{
        categoryId: string;
        name: string;
        quantity: string | null;
        revenue: string | null;
      }>();

    return results.map((r) => ({
      categoryId: r.categoryId,
      name: r.name,
      quantity: Number(r.quantity || 0),
      revenue: round2(Number(r.revenue || 0)),
    }));
  }

  async getDevicesReport(
    organizationId: string,
    queryDto: QueryReportsDto,
    user: User,
  ): Promise<DeviceReport[]> {
    await this.checkPermission(organizationId, user.id);
    const { eventId, startDate, endDate } = queryDto;

    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .leftJoin('order.createdByDevice', 'device')
      .where('order.organizationId = :organizationId', { organizationId })
      .andWhere('order.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: [OrderStatus.CANCELLED],
      });

    if (eventId) {
      queryBuilder.andWhere('order.eventId = :eventId', { eventId });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('order.createdAt BETWEEN :startDate AND :endDate', {
        startDate: startOfDay(startDate),
        endDate: endOfDay(endDate),
      });
    } else if (startDate) {
      queryBuilder.andWhere('order.createdAt >= :startDate', {
        startDate: startOfDay(startDate),
      });
    } else if (endDate) {
      queryBuilder.andWhere('order.createdAt <= :endDate', {
        endDate: endOfDay(endDate),
      });
    }

    const results = await queryBuilder
      .select([
        'order.createdByDeviceId as "deviceId"',
        'device.name as "name"',
        'COUNT(order.id) as "orders"',
        `SUM(order.total - order.pfandTotal + ${GOODWILL_NET}) as "revenue"`,
      ])
      .groupBy('order.createdByDeviceId')
      .addGroupBy('device.name')
      .orderBy(`SUM(order.total - order.pfandTotal + ${GOODWILL_NET})`, 'DESC')
      .getRawMany<{
        deviceId: string;
        name: string | null;
        orders: string | null;
        revenue: string | null;
      }>();

    return results.map((r) => ({
      deviceId: r.deviceId,
      name: r.name || 'Unbekanntes Gerät',
      orders: Number(r.orders || 0),
      revenue: Number(r.revenue || 0),
    }));
  }

  /**
   * Bericht „Bedienungen“ (bedienungen-plan.md §7): dieselben Zahlen wie die
   * Kellnerabrechnung je Bedienung bzw. Mitglied über einen Zeitraum
   * (Buchungszeitpunkt) bzw. eine Veranstaltung, ohne Testbuchungen. Eine
   * Zeile „Ohne Bedienung“ sammelt, was niemandem zugeordnet ist (Shop,
   * Kassen ohne Bedienung). Nur Mengen in „Nur Bons“ (Controller).
   */
  async getWaitersReport(
    organizationId: string,
    queryDto: QueryReportsDto,
    user: User,
  ): Promise<WaiterReportRow[]> {
    await this.checkPermission(organizationId, user.id);
    const manager = this.orderRepository.manager;
    const params: unknown[] = [
      organizationId,
      queryDto.eventId ?? null,
      queryDto.startDate ? startOfDay(queryDto.startDate) : null,
      queryDto.endDate ? endOfDay(queryDto.endDate) : null,
    ];
    const window = (alias: string, eventColumn = `${alias}.event_id`) =>
      `($2::uuid IS NULL OR ${eventColumn} = $2)
       AND ($3::timestamptz IS NULL OR ${alias}.created_at >= $3)
       AND ($4::timestamptz IS NULL OR ${alias}.created_at <= $4)`;
    const key = (waiter: string, member: string) =>
      `CASE WHEN ${waiter} IS NOT NULL THEN 'w:' || ${waiter}
            WHEN ${member} IS NOT NULL THEN 'u:' || ${member} ELSE 'none' END`;

    type Row = Record<string, string | number | null> & { key: string };
    const query = async (
      sql: string,
      values: unknown[] = params,
    ): Promise<Row[]> => await manager.query(sql, values);

    const [orders, items, payments, refunds, pfand, settlements, open] =
      await Promise.all([
        query(`SELECT ${key('o.created_by_waiter_id', 'o.created_by_user_id')} AS key,
                      count(*)::int AS orders
                 FROM orders o
                WHERE o.organization_id = $1 AND NOT o.is_test AND o.status <> 'cancelled'
                  AND ${window('o')}
                GROUP BY 1`),
        query(`SELECT ${key('oi.added_by_waiter_id', 'oi.added_by_user_id')} AS key,
                      COALESCE(sum(oi.quantity - oi.refunded_quantity), 0)::int AS items,
                      COALESCE(sum(oi.total_price), 0) AS revenue
                 FROM order_items oi JOIN orders o ON o.id = oi.order_id
                WHERE o.organization_id = $1 AND NOT o.is_test AND o.status <> 'cancelled'
                  AND oi.status <> 'cancelled' AND ${window('oi', 'o.event_id')}
                GROUP BY 1`),
        query(`SELECT ${key('p.processed_by_waiter_id', 'p.processed_by_user_id')} AS key,
                      count(*)::int AS payments, COALESCE(sum(p.amount), 0) AS collected,
                      COALESCE(sum(p.amount) FILTER (WHERE p.payment_method = 'cash'), 0) AS cash,
                      COALESCE(sum(p.amount) FILTER (WHERE p.payment_method IN ('card', 'sumup_terminal')), 0) AS card,
                      COALESCE(sum(p.tip_amount), 0) AS tips
                 FROM payments p JOIN orders o ON o.id = p.order_id
                WHERE o.organization_id = $1 AND NOT o.is_test
                  AND p.status IN ('captured', 'refunded') AND ${window('p', 'o.event_id')}
                GROUP BY 1`),
        query(`SELECT ${key('r.waiter_id', 'r.user_id')} AS key,
                      count(*)::int AS count, COALESCE(sum(abs(r.amount)), 0) AS amount
                 FROM refunds r
                WHERE r.organization_id = $1 AND NOT r.is_test AND ${window('r')}
                GROUP BY 1`),
        query(`SELECT ${key('pr.waiter_id', 'pr.created_by_user_id')} AS key,
                      COALESCE(sum(abs(pr.total_amount)), 0) AS amount
                 FROM pfand_returns pr
                WHERE pr.organization_id = $1 AND NOT pr.is_test AND ${window('pr')}
                GROUP BY 1`),
        query(`SELECT ${key('s.waiter_id', 's.user_id')} AS key, count(*)::int AS count
                 FROM waiter_settlements s
                WHERE s.organization_id = $1 AND NOT s.is_test AND ${window('s')}
                GROUP BY 1`),
        query(
          `SELECT ${key('o.waiter_id', 'NULL::uuid')} AS key, count(*)::int AS count
                 FROM orders o
                WHERE o.organization_id = $1 AND NOT o.is_test AND o.waiter_id IS NOT NULL
                  AND o.status NOT IN ('cancelled', 'completed')
                  AND o.payment_status IN ('unpaid', 'partly_paid')
                  AND o.closed_without_payment_at IS NULL
                  AND ($2::uuid IS NULL OR o.event_id = $2)
                GROUP BY 1`,
          params.slice(0, 2),
        ),
      ]);

    const rows = new Map<string, WaiterReportRow>();
    const row = (k: string): WaiterReportRow => {
      let entry = rows.get(k);
      if (!entry) {
        const [kind, id] = k === 'none' ? ['none', null] : k.split(':');
        entry = {
          kind: kind === 'w' ? 'waiter' : kind === 'u' ? 'member' : 'none',
          waiterId: kind === 'w' ? id : null,
          userId: kind === 'u' ? id : null,
          name: 'Ohne Bedienung',
          shortName: null,
          color: null,
          role: null,
          orders: 0,
          items: 0,
          revenue: 0,
          payments: 0,
          collected: 0,
          cashAmount: 0,
          cardAmount: 0,
          otherAmount: 0,
          tips: 0,
          refundCount: 0,
          refunds: 0,
          pfandReturned: 0,
          settlements: 0,
          openOrders: 0,
        };
        rows.set(k, entry);
      }
      return entry;
    };
    const n = (value: string | number | null | undefined) => Number(value ?? 0);
    for (const r of orders) row(r.key).orders = n(r.orders);
    for (const r of items) {
      row(r.key).items = n(r.items);
      row(r.key).revenue = round2(n(r.revenue));
    }
    for (const r of payments) {
      const entry = row(r.key);
      entry.payments = n(r.payments);
      entry.collected = round2(n(r.collected));
      entry.cashAmount = round2(n(r.cash));
      entry.cardAmount = round2(n(r.card));
      entry.otherAmount = round2(n(r.collected) - n(r.cash) - n(r.card));
      entry.tips = round2(n(r.tips));
    }
    for (const r of refunds) {
      row(r.key).refundCount = n(r.count);
      row(r.key).refunds = round2(n(r.amount));
    }
    for (const r of pfand) row(r.key).pfandReturned = round2(n(r.amount));
    for (const r of settlements) row(r.key).settlements = n(r.count);
    for (const r of open) row(r.key).openOrders = n(r.count);

    const waiterIds = [...rows.values()]
      .map((r) => r.waiterId)
      .filter((id): id is string => !!id);
    const userIds = [...rows.values()]
      .map((r) => r.userId)
      .filter((id): id is string => !!id);
    const waiters: {
      id: string;
      name: string;
      short_name: string | null;
      color: string | null;
      role: string;
    }[] = waiterIds.length
      ? await manager.query(
          `SELECT id, name, short_name, color, role FROM waiters
            WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
          [organizationId, waiterIds],
        )
      : [];
    const users: { id: string; name: string | null }[] = userIds.length
      ? await manager.query(
          `SELECT id, NULLIF(trim(concat_ws(' ', first_name, last_name)), '') AS name
             FROM users WHERE id = ANY($1::uuid[])`,
          [userIds],
        )
      : [];
    for (const entry of rows.values()) {
      if (entry.waiterId) {
        const w = waiters.find((x) => x.id === entry.waiterId);
        entry.name = w?.name ?? 'Bedienung (gelöscht)';
        entry.shortName = w?.short_name ?? null;
        entry.color = w?.color ?? null;
        entry.role = w?.role ?? null;
      } else if (entry.userId) {
        entry.name =
          users.find((x) => x.id === entry.userId)?.name ??
          'Mitglied (gelöscht)';
        entry.role = 'member';
      }
    }
    const order = { waiter: 0, member: 1, none: 2 } as const;
    return [...rows.values()].sort(
      (a, b) =>
        order[a.kind] - order[b.kind] ||
        b.collected - a.collected ||
        b.orders - a.orders ||
        a.name.localeCompare(b.name, 'de'),
    );
  }

  async getInventoryReport(
    eventId: string,
    user: User,
  ): Promise<
    {
      productId: string;
      productName: string;
      currentStock: number;
      lowStock: boolean;
    }[]
  > {
    await this.checkPermission(eventId, user.id);
    const products = await this.productRepository.find({
      where: { eventId, trackInventory: true },
      order: { name: 'ASC' },
    });

    return products.map((p) => ({
      productId: p.id,
      productName: p.name,
      currentStock: p.stockQuantity,
      lowStock: p.stockQuantity <= 0,
    }));
  }

  async getStockMovementsReport(
    eventId: string,
    queryDto: QueryReportsDto,
    user: User,
  ): Promise<StockMovementReport[]> {
    await this.checkPermission(eventId, user.id);
    const { startDate, endDate } = queryDto;

    const queryBuilder = this.stockMovementRepository
      .createQueryBuilder('movement')
      .leftJoin('movement.product', 'product')
      .where('movement.eventId = :eventId', { eventId });

    if (startDate && endDate) {
      queryBuilder.andWhere(
        'movement.createdAt BETWEEN :startDate AND :endDate',
        {
          startDate: startOfDay(startDate),
          endDate: endOfDay(endDate),
        },
      );
    }

    const results = await queryBuilder
      .select([
        'movement.productId as "productId"',
        'product.name as "productName"',
        'SUM(CASE WHEN movement.quantity > 0 THEN movement.quantity ELSE 0 END) as additions',
        'SUM(CASE WHEN movement.quantity < 0 THEN ABS(movement.quantity) ELSE 0 END) as deductions',
      ])
      .groupBy('movement.productId')
      .addGroupBy('product.name')
      .getRawMany<{
        productId: string;
        productName: string;
        additions: string | null;
        deductions: string | null;
      }>();

    // Get current stock for each product
    const productIds = results.map((r) => r.productId);
    const products = await this.productRepository.findByIds(productIds);
    const productMap = new Map(products.map((p) => [p.id, p]));

    return results.map((r) => {
      const product = productMap.get(r.productId);
      const additions = Number(r.additions || 0);
      const deductions = Number(r.deductions || 0);
      const closingStock = product?.stockQuantity || 0;
      const openingStock = closingStock + deductions - additions;

      return {
        productId: r.productId,
        productName: r.productName,
        openingStock,
        additions,
        deductions,
        closingStock,
      };
    });
  }

  async exportReport(
    organizationId: string,
    reportType: string,
    queryDto: QueryReportsDto,
    format: ReportExportFormat,
    user: User,
  ): Promise<{ data: string; contentType: string; filename: string }> {
    await this.checkPermission(organizationId, user.id);
    let reportData: unknown[];
    const filename = `report-${reportType}-${localDateKey(new Date())}`;

    switch (reportType) {
      case 'sales':
        reportData = [
          await this.getSalesReport(organizationId, queryDto, user),
        ];
        break;
      case 'products':
        reportData = await this.getProductsReport(
          organizationId,
          queryDto,
          user,
        );
        break;
      case 'payments':
        reportData = await this.getPaymentsReport(
          organizationId,
          queryDto,
          user,
        );
        break;
      case 'hourly':
        reportData = await this.getHourlyReport(organizationId, queryDto, user);
        break;
      case 'channels':
        reportData = await this.getChannelsReport(
          organizationId,
          queryDto,
          user,
        );
        break;
      case 'vat':
        // Eine Zeile je Steuersatz (Summe bildet die Tabelle selbst).
        reportData = (await this.getVatReport(organizationId, queryDto, user))
          .rows;
        break;
      case 'categories':
        reportData = await this.getCategoriesReport(
          organizationId,
          queryDto,
          user,
        );
        break;
      case 'waiters':
        reportData = await this.getWaitersReport(
          organizationId,
          queryDto,
          user,
        );
        break;
      case 'devices':
        reportData = await this.getDevicesReport(
          organizationId,
          queryDto,
          user,
        );
        break;
      case 'inventory':
        if (queryDto.eventId) {
          reportData = await this.getInventoryReport(queryDto.eventId, user);
        } else {
          reportData = [];
        }
        break;
      default:
        reportData = [];
    }

    // „Nur Bons“: keine Betraege, nur Mengen.
    if ((await this.getOperatingMode(organizationId)) === 'orders_only') {
      reportData = countsOnly(reportData);
    }

    if (format === ReportExportFormat.JSON) {
      return {
        data: JSON.stringify(reportData, null, 2),
        contentType: 'application/json',
        filename: `${filename}.json`,
      };
    }

    if (format === ReportExportFormat.CSV) {
      const csvData = this.convertToCSV(reportData);
      return {
        data: csvData,
        contentType: 'text/csv',
        filename: `${filename}.csv`,
      };
    }

    // For Excel, return JSON (actual Excel generation would need a library like exceljs)
    return {
      data: JSON.stringify(reportData, null, 2),
      contentType: 'application/json',
      filename: `${filename}.json`,
    };
  }

  private async checkMembership(
    organizationId: string,
    userId: string,
  ): Promise<UserOrganization> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.NOT_ORGANIZATION_MEMBER,
        message: 'Du bist kein Mitglied dieser Organisation',
      });
    }

    return membership;
  }

  private async checkPermission(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const membership = await this.checkMembership(organizationId, userId);

    if (
      membership.role !== OrganizationRole.ADMIN &&
      !membership.permissions?.reports
    ) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }
  }

  private convertToCSV(data: unknown[]): string {
    if (data.length === 0) return '';

    const headers = Object.keys(data[0] as Record<string, unknown>);
    const rows = data.map((row) =>
      headers
        .map((h) => {
          // Berichtszeilen tragen nur primitive Werte (Zahlen, Texte, null).
          const val = (row as Record<string, CsvZelle>)[h];
          if (typeof val === 'string' && val.includes(',')) {
            return `"${val}"`;
          }
          return String(val ?? '');
        })
        .join(','),
    );

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Systemstatus fuer die Statusleiste des Dashboards.
   *
   * Die Designvorlage zeigt an dieser Stelle eine TSE-Kachel. Eine TSE
   * gibt es in OpenEOS nicht, deshalb steht dort die Zahl der offenen
   * Bestellungen — eine Kennzahl, die tatsaechlich existiert, statt einer
   * erfundenen.
   *
   * Online ist keine Spalte, sondern eine Laufzeit-Eigenschaft: welche
   * Geraete verbunden sind, weiss allein das Gateway. Die Liste der
   * verbundenen Geraete wird deshalb hereingereicht, statt sie hier aus
   * der Datenbank zu raten (lastSeenAt sagt nur, wann zuletzt etwas kam).
   */
  async getSystemStatus(
    organizationId: string,
    user: User,
    onlineDeviceIds: string[],
  ) {
    await this.checkPermission(organizationId, user.id);

    const online = new Set(onlineDeviceIds);
    const since = new Date(Date.now() - 60 * 60 * 1000);

    const [devices, printers, queuedJobs, jobsLastHour, openOrders] =
      await Promise.all([
        this.deviceRepository.find({
          where: { organizationId },
          select: { id: true, type: true },
        }),
        this.printerRepository.find({
          where: { organizationId, isActive: true },
          select: { id: true, isOnline: true },
        }),
        this.printJobRepository.count({
          where: { organizationId, status: 'queued' as never },
        }),
        this.printJobRepository.count({
          where: {
            organizationId,
            status: 'completed' as never,
            updatedAt: MoreThanOrEqual(since),
          },
        }),
        this.orderRepository.count({
          where: { organizationId, status: OrderStatus.OPEN },
        }),
      ]);

    const posDevices = devices.filter((d) => d.type === DeviceType.POS);

    return {
      pos: {
        online: posDevices.filter((d) => online.has(d.id)).length,
        total: posDevices.length,
      },
      printers: {
        online: printers.filter((p) => p.isOnline).length,
        total: printers.length,
      },
      printQueue: {
        queued: queuedJobs,
        completedLastHour: jobsLastHour,
      },
      openOrders,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Ereignisstrom für das Dashboard.
   *
   * Die Designvorlage zeigt hier ein "Audit-Log" mit TSE-Signaturen.
   * Eine TSE gibt es in OpenEOS nicht, und ein eigenes Ereignis-Journal
   * ebenso wenig. Statt eines zu erfinden, wird der Strom aus dem
   * zusammengesetzt, was tatsächlich protokolliert wird: angelegte
   * Bestellungen, gebuchte Zahlungen und Druckaufträge samt Fehlern.
   *
   * Bewusst drei getrennte Abfragen mit anschließendem Mischen statt
   * einer UNION: die Tabellen haben nichts gemeinsam außer dem
   * Zeitstempel, und drei schlanke Abfragen mit LIMIT sind hier
   * billiger als ein Konstrukt, das der Planer nicht indexgestützt
   * auflösen kann.
   */
  async getActivityStream(organizationId: string, user: User, limit = 20) {
    await this.checkPermission(organizationId, user.id);

    const [orders, payments, jobs] = await Promise.all([
      this.orderRepository.find({
        where: { organizationId },
        order: { createdAt: 'DESC' },
        take: limit,
        select: {
          id: true,
          orderNumber: true,
          total: true,
          status: true,
          createdAt: true,
        },
      }),
      /* Payment kennt keine organizationId — es haengt an der
         Bestellung. Deshalb ueber den Join statt ueber eine Spalte,
         die es nicht gibt. */
      this.paymentRepository
        .createQueryBuilder('payment')
        .innerJoin('payment.order', 'order')
        .where('order.organizationId = :organizationId', { organizationId })
        .orderBy('payment.createdAt', 'DESC')
        .take(limit)
        .getMany(),
      this.printJobRepository.find({
        where: { organizationId },
        order: { createdAt: 'DESC' },
        take: limit,
        select: { id: true, status: true, error: true, createdAt: true },
      }),
    ]);

    type Eintrag = {
      id: string;
      at: string;
      kind: 'order' | 'payment' | 'print';
      tone: 'neutral' | 'ok' | 'error';
      message: string;
      amount: number | null;
    };

    const eintraege: Eintrag[] = [
      ...orders.map<Eintrag>((o) => ({
        id: `order:${o.id}`,
        at: o.createdAt.toISOString(),
        kind: 'order',
        tone: o.status === OrderStatus.CANCELLED ? 'error' : 'neutral',
        message: o.orderNumber,
        amount: Number(o.total),
      })),
      ...payments.map<Eintrag>((p) => ({
        id: `payment:${p.id}`,
        at: p.createdAt.toISOString(),
        kind: 'payment',
        tone: p.status === PaymentTransactionStatus.FAILED ? 'error' : 'ok',
        message: p.paymentMethod,
        amount: Number(p.amount),
      })),
      ...jobs.map<Eintrag>((j) => ({
        id: `print:${j.id}`,
        at: j.createdAt.toISOString(),
        kind: 'print',
        tone: j.status === PrintJobStatus.FAILED ? 'error' : 'ok',
        /* Bei Fehlern trägt die Meldung die Ursache — sonst müsste man
           für jeden fehlgeschlagenen Druck ins Log steigen. */
        message: j.error ?? j.status,
        amount: null,
      })),
    ];

    return eintraege.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }
}

/**
 * Abgleich aus den Summen der Abfragen. `goodwillGoods` ist der Warenanteil
 * aller Kulanz-Erstattungen (negativ), `attributedRefunds` der Teil davon,
 * der ueber erstattete Mengen bei den Produkten abgezogen ist (positiv) —
 * der Rest sind die Erstattungen ohne Position.
 */
/** Zwei Betraege-je-Satz-Tabellen (Cent) zusammenzaehlen. */
function addRateMaps(
  a: Map<number, number>,
  b: Map<number, number>,
): Map<number, number> {
  const out = new Map(a);
  for (const [rate, value] of b) out.set(rate, (out.get(rate) ?? 0) + value);
  return out;
}

export function netSalesSummary(input: {
  netRevenue: number;
  tips: number;
  goodwillGoods: number;
  itemsRevenue: number;
  attributedRefunds: number;
}): NetSalesSummary {
  return {
    itemsRevenue: round2(input.itemsRevenue),
    unassignedRefunds: round2(input.goodwillGoods + input.attributedRefunds),
    tips: round2(input.tips),
    netRevenue: round2(input.netRevenue),
  };
}
