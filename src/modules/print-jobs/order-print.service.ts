import {
  OPERATING_MODE_SELECT,
  isOrdersOnly,
} from '../../common/utils/operating-mode.util';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventPhaseService } from '../events/event-phase.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Device } from '../../database/entities/device.entity';
import { Organization } from '../../database/entities/organization.entity';
import {
  OrderItem,
  OrderItemStatus,
} from '../../database/entities/order-item.entity';
import { Order } from '../../database/entities/order.entity';
import { Event, EventStatus } from '../../database/entities/event.entity';
import { PrintJobsService } from './print-jobs.service';
import { PrintRoutingService } from './print-routing.service';
import { buildReceiptTax, cashChange } from './receipt-tax.util';
import type { Refund } from '../../database/entities/refund.entity';
import type { PfandReturn } from '../../database/entities/pfand-return.entity';
import { tsePrintBlock, type TseReceiptView } from '../tse/tse-view';
import { organizationPrintBlock, paymentMethodLabel } from './receipt-labels';
import {
  NO_ORDER_STAFF,
  loadOrderStaff,
  orderStaffPayload,
  type OrderStaff,
} from './order-staff';
import {
  CANCELLATION_TICKET_TEMPLATE,
  PFAND_RETURN_RECEIPT_TEMPLATE,
  WAITER_SETTLEMENT_TEMPLATE,
  REFUND_RECEIPT_TEMPLATE,
  HOSPITALITY_RECEIPT_TEMPLATE,
} from './builtin-templates';

const REASON_LABELS: Record<string, string> = {
  wrong_order: 'Falsch bestellt',
  quality: 'Qualitaet',
  not_delivered: 'Nicht geliefert',
  customer_request: 'Wunsch des Gastes',
  duplicate: 'Doppelt gebucht',
  price_error: 'Falscher Preis',
  other: 'Sonstiges',
};

export function refundReasonLabel(
  code: string | null | undefined,
  text: string | null | undefined,
): string | null {
  const label = code ? (REASON_LABELS[code] ?? code) : null;
  const extra = text?.trim();
  if (label && extra) return `${label}: ${extra}`;
  return label ?? extra ?? null;
}

/** Zahlung, zu der ein Kassenbon entsteht (Druck oder digitaler Beleg). */
export interface ReceiptPaymentData {
  orderId: string;
  orderNumber: string;
  paymentId: string;
  amount: number;
  paymentMethod: string;
  isFullyPaid: boolean;
  order: Order | null;
  /** Bei Barzahlung: erhaltener Betrag aus `payment.metadata`, fuers Rueckgeld. */
  amountReceived?: unknown;
  /**
   * TSE-Daten des Kassenbelegs (oder Ausfallvermerk). Der Bon entsteht
   * erst nach der Signatur (AEAO zu § 146a Nr. 2.5).
   */
  tse?: TseReceiptView | null;
  /**
   * Geraet, dessen Bon-Drucker gilt (Knopf „Bon drucken“ an einer anderen
   * Kasse als der, die bestellt hat). Standard: Geraet der Bestellung.
   */
  printDeviceId?: string | null;
  /**
   * Auf Wunsch gedruckt („Bon drucken“/Nachdruck an der Kasse): druckt
   * auch, wenn der automatische Kassenbon aus ist. Gab es fuer diese
   * Zahlung schon einen Kassenbon, ist es ein Nachdruck (Vermerk
   * „NACHDRUCK“, eine spaet eingetroffene Signatur gekennzeichnet).
   */
  onDemand?: boolean;
}

@Injectable()
export class OrderPrintService {
  private readonly logger = new Logger(OrderPrintService.name);

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepository: Repository<OrderItem>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    private readonly printJobsService: PrintJobsService,
    private readonly printRoutingService: PrintRoutingService,
    @Optional()
    private readonly eventPhaseService?: EventPhaseService,
  ) {}

  /**
   * Whether the order's event is currently in TEST status. Order-creation and
   * payment call sites don't consistently load the `event` relation, so this
   * re-queries by eventId rather than trusting `order.event` to be populated.
   * Printer-agent templates should render a "*** TESTMODUS ***" banner when
   * `is_test` is true (follow-up on the printer-agent side — the API has no
   * server-side template rendering step to inject the banner text into).
   */
  private async isTestEvent(
    eventId: string | null | undefined,
  ): Promise<boolean> {
    if (!eventId) return false;
    const event = await this.eventRepository.findOne({
      where: { id: eventId },
    });
    if (event?.status === EventStatus.TEST) return true;
    if (!event) return false;
    // Zustand „Geplant“: die Kasse bucht Testbestellungen.
    const phase =
      this.eventPhaseService ??
      EventPhaseService.standalone(this.organizationRepository);
    return phase.isTestModeNow(event);
  }

  /**
   * Testbon? Eine Testbestellung immer; eine echte Bestellung nur im
   * Testmodus der Veranstaltung — eine echte Vorverkaufs-Bestellung im
   * Zustand „Geplant“ bekommt keinen Testvermerk.
   */
  private async isTestOrder(
    order: { eventId?: string | null; isTest?: boolean } | null | undefined,
  ): Promise<boolean> {
    if (order?.isTest === true) return true;
    if (order?.isTest === false) {
      if (!order.eventId) return false;
      const event = await this.eventRepository.findOne({
        where: { id: order.eventId },
        select: ['id', 'status'],
      });
      return event?.status === EventStatus.TEST;
    }
    return this.isTestEvent(order?.eventId ?? null);
  }

  /** Betriebsart „Nur Bons“: Bons ohne Preise, keine Kassenbons. */
  private async hidesPrices(organizationId: string): Promise<boolean> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: OPERATING_MODE_SELECT,
    });
    return isOrdersOnly(organization);
  }

  /** Aktive Positionen fuer den Bestellbon (Menge, Name, Betrag, Notiz). */
  private async ticketItems(
    order: Order | null,
    orderId: string,
  ): Promise<Record<string, unknown>[]> {
    const items =
      order?.items && order.items.length
        ? order.items
        : await this.orderItemRepository.find({
            where: { orderId },
            order: { createdAt: 'ASC' },
          });
    return items
      .filter((it) => it.status !== OrderItemStatus.CANCELLED)
      .map((it) => ({
        quantity: it.quantity,
        name: it.productName,
        total: it.totalPrice,
        notes: it.notes ?? null,
        options: this.formatOptions(it),
      }));
  }

  private async deviceHasDefaultPrinter(deviceId: string): Promise<boolean> {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId },
      select: ['id', 'settings'],
    });
    return !!device?.settings?.defaultPrinterId;
  }

  /**
   * Build a snake_case payload that matches the field names used by the
   * printer agent's Jinja2 templates (kitchen_ticket / order_ticket / receipt).
   * The agent expects fields like `created_at`, `daily_number`, `customer_name`
   * — not the camelCase entity fields used elsewhere in the API.
   */
  private buildOrderPayload(
    order: Order | null,
    staff: OrderStaff,
  ): Record<string, unknown> {
    if (!order) return {};
    return {
      // Bon-Elemente „Bedienung“/„Gerät“ (leer → Vorlage laesst sie weg).
      ...orderStaffPayload(staff),
      order_id: order.id,
      order_number: order.orderNumber,
      daily_number: order.dailyNumber ?? null,
      table_number: order.tableNumber ?? null,
      customer_name: order.customerName ?? null,
      priority: order.priority ?? 'normal',
      created_at: order.createdAt ?? null,
      // Channel info so the kitchen template can render a clear "where does
      // this go" banner (Bedienung→Tisch / Online→Abholung / SB→Theke).
      source: order.source ?? 'pos',
      fulfillment_type: order.fulfillmentType ?? 'counter_pickup',
      // Pass the raw entity too in case a template wants nested access.
      order,
    };
  }

  /**
   * Wer die Bestellung aufgenommen hat (Geraet, sonst Web-Nutzer), einmal je
   * Druckvorgang geladen und an alle Bons dieser Bestellung gegeben. Ein
   * Fehler hier darf keinen Bon verhindern.
   */
  private async orderStaff(order: Order | null): Promise<OrderStaff> {
    try {
      return await loadOrderStaff(this.deviceRepository, order);
    } catch (error) {
      this.logger.warn(
        `Could not load waiter/device name for order ${order?.id}: ${(error as Error).message}`,
      );
      return NO_ORDER_STAFF;
    }
  }

  /**
   * Build the `organization` payload (name/address/phone) so templates that
   * include organization fields render on any workflow — not just receipts.
   * Kitchen/order tickets use StrictUndefined, so an `{{ organization.* }}`
   * reference throws "'organization' is undefined" when this is missing.
   */
  private async buildOrgPayload(
    organizationId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const org = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: ['id', 'name', 'settings'],
    });
    if (!org) return undefined;
    return organizationPrintBlock(org);
  }

  async handleOrderCreated(
    organizationId: string,
    data: {
      order: Order | null;
      orderId: string;
      orderNumber: string;
      tableNumber?: string | null;
      total: number;
      source: string;
    },
  ): Promise<void> {
    try {
      const orderFlow = (await this.getOrderFlow(organizationId)) ?? {};
      const orderDeviceId: string | null =
        data.order?.createdByDeviceId ?? null;
      const isTest = await this.isTestOrder(data.order);
      const staff = await this.orderStaff(data.order);

      // Kitchen ticket(s) on order creation — supports three dispatch modes.
      // The kitchen toggle gates ORG-level routing only. If a device has a
      // defaultPrinterId assigned, that's an explicit per-device intent to
      // print, so the device-fallback path should still fire even when the
      // org-level kitchen toggle is off (or has never been configured).
      const kitchen = orderFlow.kitchenTicketPrinting;
      const orgKitchenDisabled = kitchen?.enabled === false;
      const deviceHasFallback =
        !!orderDeviceId &&
        !!(await this.deviceHasDefaultPrinter(orderDeviceId));
      if (!orgKitchenDisabled || deviceHasFallback) {
        await this.dispatchKitchenTickets(
          organizationId,
          orderDeviceId,
          {
            templateId: kitchen?.templateId ?? null,
            mode: kitchen?.mode ?? 'per_order',
            orgFallbackPrinterId: kitchen?.printerId ?? null,
          },
          data,
          isTest,
          staff,
        );
      }

      // Order ticket on order creation (always per_order)
      const orderTicket = orderFlow.orderTicketPrinting;
      if (orderTicket?.enabled) {
        const { printerId } =
          await this.printRoutingService.resolveOrderPrinter({
            organizationId,
            orderDeviceId,
            workflow: 'order_ticket',
          });
        if (printerId) {
          await this.printJobsService.createFromWorkflow(
            organizationId,
            printerId,
            orderTicket.templateId || null,
            data.orderId,
            1,
            {
              ...this.buildOrderPayload(data.order, staff),
              organization: await this.buildOrgPayload(organizationId),
              // Positionen fuer die Liste des Bestellbons (wie beim Kassenbon).
              items: await this.ticketItems(data.order, data.orderId),
              total: data.total,
              source: data.source,
              is_test: isTest,
            },
            null,
            'order_ticket',
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Failed to handle order created printing for org ${organizationId}: ${(error as Error).message}`,
      );
    }
  }

  private async dispatchKitchenTickets(
    organizationId: string,
    orderDeviceId: string | null,
    kitchen: {
      templateId: string | null;
      mode: 'per_order' | 'per_item' | 'per_station';
      orgFallbackPrinterId: string | null;
    },
    data: {
      order: Order | null;
      orderId: string;
      orderNumber: string;
      tableNumber?: string | null;
      total: number;
      source: string;
    },
    isTest: boolean,
    staff: OrderStaff,
  ): Promise<void> {
    const { mode, templateId } = kitchen;
    const orgPayload = await this.buildOrgPayload(organizationId);

    if (mode === 'per_order') {
      const { printerId } = await this.printRoutingService.resolveOrderPrinter({
        organizationId,
        orderDeviceId,
        workflow: 'kitchen',
      });
      if (!printerId) {
        this.logger.warn(
          `No printer resolved for kitchen per_order ticket of order ${data.orderId} (org ${organizationId})`,
        );
        return;
      }
      await this.printJobsService.createFromWorkflow(
        organizationId,
        printerId,
        templateId,
        data.orderId,
        1,
        {
          ...this.buildOrderPayload(data.order, staff),
          organization: orgPayload,
          total: data.total,
          source: data.source,
          is_test: isTest,
        },
        null,
        'kitchen_ticket',
      );
      return;
    }

    // Both per_item and per_station need the actual order items.
    const items = await this.orderItemRepository.find({
      where: { orderId: data.orderId },
      relations: ['product', 'product.category', 'productionStation'],
      order: { createdAt: 'ASC' },
    });
    if (items.length === 0) return;

    if (mode === 'per_item') {
      for (const item of items) {
        const { printerId } = await this.printRoutingService.resolveItemPrinter(
          {
            item,
            orderDeviceId,
            organizationId,
          },
        );
        const resolvedPrinterId = printerId ?? kitchen.orgFallbackPrinterId;
        if (!resolvedPrinterId) {
          this.logger.warn(
            `No printer resolved for kitchen per_item (item ${item.id}, order ${data.orderId}, org ${organizationId})`,
          );
          continue;
        }
        await this.printJobsService.createFromWorkflow(
          organizationId,
          resolvedPrinterId,
          templateId,
          data.orderId,
          1,
          {
            ...this.buildOrderPayload(data.order, staff),
            organization: orgPayload,
            // Single-item items array so the kitchen template's items_list still
            // renders cleanly. The barcode field uses order_item_id.
            items: [
              {
                quantity: item.quantity,
                name: item.productName,
                notes: item.notes ?? null,
                kitchen_notes: item.kitchenNotes ?? null,
                options: this.formatOptions(item),
              },
            ],
            order_item_id: item.id,
            is_test: isTest,
          },
          item.id,
          'kitchen_ticket',
        );
      }
      return;
    }

    if (mode === 'per_station') {
      // Group items by *production station*, then by resolved printer. One
      // ticket per (printer, station) so even a fixed-printer POS prints a
      // separate ticket per Produktionsstandort (e.g. Getränke vs. Essen on
      // the same printer). Items without a station fall into a per-printer
      // bucket that prints under the generic "KÜCHE" banner.
      type Bucket = {
        printerId: string;
        stationName: string | null;
        stationId: string | null;
        items: OrderItem[];
      };
      const buckets = new Map<string, Bucket>();

      for (const item of items) {
        const { printerId } = await this.printRoutingService.resolveItemPrinter(
          {
            item,
            orderDeviceId,
            organizationId,
          },
        );
        const resolvedPrinterId = printerId ?? kitchen.orgFallbackPrinterId;
        if (!resolvedPrinterId) {
          this.logger.warn(
            `No printer resolved for kitchen per_station item ${item.id} (order ${data.orderId}, org ${organizationId}); skipping`,
          );
          continue;
        }
        const station = item.productionStation;
        const stationKey = item.productionStationId ?? '__nostation__';
        const key = `${resolvedPrinterId}::${stationKey}`;
        const existing = buckets.get(key);
        if (existing) {
          existing.items.push(item);
        } else {
          buckets.set(key, {
            printerId: resolvedPrinterId,
            // null → the kitchen template renders its generic "KÜCHE" banner.
            stationName: station?.name ?? null,
            stationId: station?.id ?? null,
            items: [item],
          });
        }
      }

      for (const bucket of buckets.values()) {
        await this.printJobsService.createFromWorkflow(
          organizationId,
          bucket.printerId,
          templateId,
          data.orderId,
          1,
          {
            ...this.buildOrderPayload(data.order, staff),
            organization: orgPayload,
            station_name: bucket.stationName,
            station_id: bucket.stationId,
            items: bucket.items.map((it) => ({
              quantity: it.quantity,
              name: it.productName,
              notes: it.notes ?? null,
              kitchen_notes: it.kitchenNotes ?? null,
              options: this.formatOptions(it),
            })),
            is_test: isTest,
          },
          null,
          'kitchen_ticket',
        );
      }
    }
  }

  /**
   * Build the option lines for a kitchen ticket. The kitchen only cares about
   * *deviations* from the standard product, not the full ingredient list:
   *   - excluded ingredients  → "ohne X"   (e.g. "ohne Zwiebeln")
   *   - paid extras (priceModifier > 0) → "+ X"
   * Kept default / free options (not excluded, no surcharge) are noise on a
   * kitchen ticket and are dropped.
   */
  private formatOptions(item: OrderItem): string[] {
    const selected =
      (
        item.options as {
          selected?: Array<{
            option?: string;
            excluded?: boolean;
            priceModifier?: number;
          }>;
        } | null
      )?.selected ?? [];
    return selected
      .map((o) => {
        const name = o.option ?? '';
        if (!name) return '';
        if (o.excluded) return `ohne ${name}`;
        if (Number(o.priceModifier) > 0) return `+ ${name}`;
        // Every chosen option matters to the kitchen even when it's free —
        // e.g. a "Zero" variant or a "Ketchup"/"Senf" extra. Show its name.
        return name;
      })
      .filter(Boolean);
  }

  /** Gab es fuer diese Zahlung schon einen Kassenbon (Druckauftrag)? */
  private async receiptPrintedBefore(
    organizationId: string,
    paymentId: string,
  ): Promise<boolean> {
    try {
      const rows: unknown[] = await this.organizationRepository.manager.query(
        `SELECT 1 FROM print_jobs
          WHERE organization_id = $1 AND payload->>'paymentId' = $2
          LIMIT 1`,
        [organizationId, paymentId],
      );
      return Array.isArray(rows) && rows.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Daten des Kassenbons (`receipt`) einer Zahlung — dieselben fuer den
   * gedruckten Bon und den digitalen Beleg (QR-Code, E-Mail, PDF), damit
   * beide nicht auseinanderlaufen koennen.
   */
  async receiptPayload(
    organizationId: string,
    data: ReceiptPaymentData,
    options: { reprint?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const reprint = options.reprint === true;
    const isTest = await this.isTestOrder(data.order);
    // Receipt template needs organization + monetary detail. Load org once.
    const org = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: ['id', 'name', 'settings'],
    });
    const orgPayload = org ? organizationPrintBlock(org) : undefined;
    // The receipt's items_list iterates a top-level `items` array
    // (item.quantity/name/total/...). Without it the receipt prints no
    // products. Load + map the order items just like the kitchen path.
    const receiptItems = await this.orderItemRepository.find({
      where: { orderId: data.orderId },
      order: { createdAt: 'ASC' },
    });
    const staff = await this.orderStaff(data.order);
    return {
      ...this.buildOrderPayload(data.order, staff),
      organization: orgPayload,
      items: receiptItems
        .filter((it) => it.status !== OrderItemStatus.CANCELLED)
        .map((it) => ({
          quantity: it.quantity,
          name: it.productName,
          total: it.totalPrice,
          notes: it.notes ?? null,
          options: this.formatOptions(it),
        })),
      total: data.order?.total,
      subtotal: data.order?.subtotal,
      // MwSt je Satz aus den Positionen; fehlt bei steuerbefreiten
      // Organisationen ganz, damit der Bon keine MwSt-Zeile druckt.
      ...buildReceiptTax(
        receiptItems,
        data.order?.discountAmount,
        org?.settings?.vatExempt,
      ),
      // Pfand (deposit) is part of `total` but not `subtotal`, which is
      // why total > subtotal. Expose it so the receipt can show it.
      pfand_total: data.order?.pfandTotal ?? null,
      discount_amount: data.order?.discountAmount ?? null,
      paid_amount: data.order?.paidAmount,
      change: cashChange(data.paymentMethod, data.amount, data.amountReceived),
      payment_method: data.paymentMethod,
      // Anzeigename („Bar“, „Karte (SumUp)“ …) statt des Rohwerts.
      payment_label: paymentMethodLabel(data.paymentMethod),
      paymentId: data.paymentId,
      amount: data.amount,
      isFullyPaid: data.isFullyPaid,
      is_test: isTest,
      reprint,
      tse: tsePrintBlock(data.tse, { reprint }),
    };
  }

  /**
   * Kassenbon nach der Zahlung. Automatisch nur mit der Einstellung
   * „Kassenbon“ (Ausloeser Zahlung); `onDemand` (Knopf „Bon drucken“ an
   * der Kasse, Nachdruck) druckt auch, wenn der automatische Bon aus ist.
   * Liefert, ob ein Druckauftrag entstanden ist.
   */
  async handlePaymentReceived(
    organizationId: string,
    data: ReceiptPaymentData,
  ): Promise<boolean> {
    try {
      const orderFlow = (await this.getOrderFlow(organizationId)) ?? {};
      const orderDeviceId: string | null =
        data.order?.createdByDeviceId ?? null;

      // Betriebsart „Nur Bons“: keine Kassenbons (keine Preise, keine
      // Zahlungen; Online-Zahlungen aus der Zeit davor eingeschlossen).
      if (await this.hidesPrices(organizationId)) return false;

      // Receipt printing on payment.
      const receipt = orderFlow.receiptPrinting;
      const trigger = receipt?.trigger ?? 'payment_received';
      // Opt-in: only print a receipt when explicitly enabled (consistent with
      // order-ticket printing). An unset/null receiptPrinting means "off", so
      // deactivating it actually stops the receipt.
      const automatic = !!receipt?.enabled && trigger === 'payment_received';
      if (!automatic && !data.onDemand) return false;
      // Auf Wunsch und schon einmal gedruckt: Nachdruck (Vermerk, ggf.
      // spaet eingetroffene Signatur).
      const reprint =
        data.onDemand === true &&
        (await this.receiptPrintedBefore(organizationId, data.paymentId));
      const { printerId } = await this.printRoutingService.resolveOrderPrinter({
        organizationId,
        orderDeviceId: data.printDeviceId ?? orderDeviceId,
        workflow: 'receipt',
      });
      if (!printerId) return false;
      await this.printJobsService.createFromWorkflow(
        organizationId,
        printerId,
        receipt?.templateId || null,
        data.orderId,
        1,
        await this.receiptPayload(organizationId, data, { reprint }),
        null,
        'receipt',
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to handle payment received printing for org ${organizationId}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Gegenbeleg einer Erstattung auf den Kassenbon-Drucker (Geraet der
   * Erstattung, sonst Bon-Drucker der Organisation). Gedruckt wird immer,
   * wenn ein Drucker gefunden wird — auch wenn der automatische Kassenbon
   * aus ist, denn der Gegenbeleg belegt die Auszahlung. Liefert, ob ein
   * Druckauftrag entstanden ist.
   */
  async printRefundReceipt(
    organizationId: string,
    data: {
      refund: Refund;
      order: Order;
      deviceId: string | null;
      deviceName?: string | null;
      reprint?: boolean;
      /** TSE-Daten des Gegenbelegs (oder Ausfallvermerk). */
      tse?: TseReceiptView | null;
    },
  ): Promise<boolean> {
    try {
      const { refund, order } = data;
      const { printerId } = await this.printRoutingService.resolveOrderPrinter({
        organizationId,
        orderDeviceId: data.deviceId ?? order.createdByDeviceId ?? null,
        workflow: 'receipt',
      });
      if (!printerId) return false;
      const isTest = refund.isTest || (await this.isTestOrder(order));
      const taxLines = refund.taxLines ?? [];
      // `device_name` bleibt hier das Geraet der Erstattung (unten).
      const staff = await this.orderStaff(order);
      await this.printJobsService.createFromWorkflow(
        organizationId,
        printerId,
        null,
        order.id,
        1,
        {
          ...this.buildOrderPayload(order, staff),
          organization: await this.buildOrgPayload(organizationId),
          created_at: refund.createdAt,
          original_created_at: order.createdAt,
          refund_id: refund.id,
          refund_number: refund.refundNumber,
          refund_kind: refund.kind,
          items: (refund.items ?? []).map((item) => ({
            quantity: item.quantity,
            name: item.productName,
            total: Number(item.amount),
            unit_price: Number(item.unitPrice),
            tax_rate: Number(item.taxRate),
            cancelled: item.cancelled,
          })),
          pfand_amount: Number(refund.pfandAmount) || 0,
          tip_amount: Number(refund.tipAmount) || 0,
          tax_lines: taxLines,
          tax_amount: Number(refund.taxTotal) || 0,
          total: Number(refund.amount),
          payment_method: refund.paymentMethod,
          payment_label: paymentMethodLabel(refund.paymentMethod),
          refund_status: refund.status,
          provider_reference: refund.providerReference,
          reason: refundReasonLabel(refund.reasonCode, refund.reasonText),
          actor_name: refund.actorName,
          device_name: data.deviceName ?? null,
          reprint: data.reprint === true,
          is_test: isTest,
          tse: tsePrintBlock(data.tse, { reprint: data.reprint === true }),
        },
        null,
        REFUND_RECEIPT_TEMPLATE,
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to print refund receipt for org ${organizationId}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Druckt die Kasse Kassenbons automatisch nach der Zahlung
   * (Einstellung „Kassenbon“, Ausloeser Zahlung)? Dieselbe Regel gilt fuer
   * den Beleg einer Pfand-Auszahlung — sonst druckt die Kasse ihn auf
   * Wunsch („Bon drucken“), wie beim Verkauf.
   */
  async autoPrintsReceipts(organizationId: string): Promise<boolean> {
    const receipt = (await this.getOrderFlow(organizationId))?.receiptPrinting;
    return (
      !!receipt?.enabled &&
      (receipt.trigger ?? 'payment_received') === 'payment_received'
    );
  }

  /**
   * Beleg einer Pfand-Auszahlung („Pfandrückgabe“) auf den Kassenbon-Drucker
   * des Geraets (sonst Bon-Drucker der Organisation). Liefert, ob ein
   * Druckauftrag entstanden ist.
   */
  async printPfandReturnReceipt(
    organizationId: string,
    data: {
      pfandReturn: PfandReturn;
      deviceName?: string | null;
      actorName?: string | null;
      reprint?: boolean;
      /** TSE-Daten der Auszahlung (oder Ausfallvermerk). */
      tse?: TseReceiptView | null;
    },
  ): Promise<boolean> {
    try {
      const { pfandReturn } = data;
      const { printerId } = await this.printRoutingService.resolveOrderPrinter({
        organizationId,
        orderDeviceId: pfandReturn.deviceId ?? null,
        workflow: 'receipt',
      });
      if (!printerId) return false;
      const event = pfandReturn.eventId
        ? await this.eventRepository.findOne({
            where: { id: pfandReturn.eventId },
            select: ['id', 'name'],
          })
        : null;
      await this.printJobsService.createFromWorkflow(
        organizationId,
        printerId,
        null,
        null,
        1,
        {
          organization: await this.buildOrgPayload(organizationId),
          ...pfandReturnPrintData(pfandReturn),
          event_name: event?.name ?? null,
          device_name: data.deviceName ?? null,
          actor_name: data.actorName ?? null,
          reprint: data.reprint === true,
          is_test: pfandReturn.isTest === true,
          tse: tsePrintBlock(data.tse),
        },
        null,
        PFAND_RETURN_RECEIPT_TEMPLATE,
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to print pfand return receipt for org ${organizationId}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Kellnerabrechnung bzw. Zwischenstand (Vorlage `waiter_settlement`) auf
   * den gewaehlten Drucker, sonst den Kassenbon-Drucker des Geraets (bzw.
   * der Organisation). Liefert, ob ein Druckauftrag entstanden ist.
   */
  async printWaiterSettlement(
    organizationId: string,
    target: { printerId?: string | null; deviceId?: string | null },
    data: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const printerId =
        target.printerId ||
        (
          await this.printRoutingService.resolveOrderPrinter({
            organizationId,
            orderDeviceId: target.deviceId ?? null,
            workflow: 'receipt',
          })
        ).printerId;
      if (!printerId) return false;
      await this.printJobsService.createFromWorkflow(
        organizationId,
        printerId,
        null,
        null,
        1,
        { organization: await this.buildOrgPayload(organizationId), ...data },
        null,
        WAITER_SETTLEMENT_TEMPLATE,
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to print waiter settlement for org ${organizationId}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Bewirtungsbeleg (Vorlage `hospitality_receipt`) auf den Bon-Drucker
   * des Geraets, sonst der Organisation. Die Bausteine kommen fertig
   * (ASCII) aus dem Beleg-Modul. Liefert, ob ein Druckauftrag entstand.
   */
  async printHospitalityReceipt(
    organizationId: string,
    data: {
      deviceId: string | null;
      orderId: string | null;
      isTest: boolean;
      blocks: unknown[];
    },
  ): Promise<boolean> {
    try {
      const { printerId } = await this.printRoutingService.resolveOrderPrinter({
        organizationId,
        orderDeviceId: data.deviceId,
        workflow: 'receipt',
      });
      if (!printerId) return false;
      await this.printJobsService.createFromWorkflow(
        organizationId,
        printerId,
        null,
        data.orderId,
        1,
        { blocks: data.blocks, is_test: data.isTest },
        null,
        HOSPITALITY_RECEIPT_TEMPLATE,
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to print hospitality receipt for org ${organizationId}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Storno-Bon fuer die Kueche/Station: dieselben Drucker wie der
   * Kuechenbon (je Produktionsstandort), nur wenn auch Kuechenbons gedruckt
   * werden. So weiss die Kueche, dass ein schon gedruckter Bon nicht mehr
   * gilt.
   */
  async printCancellationTickets(
    organizationId: string,
    data: {
      order: Order;
      items: { item: OrderItem; quantity: number }[];
      reason?: string | null;
    },
  ): Promise<void> {
    try {
      if (data.items.length === 0) return;
      const orderFlow = (await this.getOrderFlow(organizationId)) ?? {};
      const kitchen = orderFlow.kitchenTicketPrinting;
      const orderDeviceId = data.order.createdByDeviceId ?? null;
      const deviceHasFallback =
        !!orderDeviceId && (await this.deviceHasDefaultPrinter(orderDeviceId));
      if (kitchen?.enabled === false && !deviceHasFallback) return;

      const isTest = await this.isTestOrder(data.order);
      const orgPayload = await this.buildOrgPayload(organizationId);
      const staff = await this.orderStaff(data.order);
      const withRelations = await this.orderItemRepository.find({
        where: data.items.map(({ item }) => ({ id: item.id })),
        relations: ['product', 'productionStation'],
      });
      const byId = new Map(withRelations.map((i) => [i.id, i]));

      const buckets = new Map<
        string,
        {
          printerId: string;
          stationName: string | null;
          lines: { item: OrderItem; quantity: number }[];
        }
      >();
      for (const line of data.items) {
        const item = byId.get(line.item.id) ?? line.item;
        let printerId: string | null = null;
        if (kitchen?.mode === 'per_order' || !kitchen?.mode) {
          printerId = (
            await this.printRoutingService.resolveOrderPrinter({
              organizationId,
              orderDeviceId,
              workflow: 'kitchen',
            })
          ).printerId;
        } else {
          printerId =
            (
              await this.printRoutingService.resolveItemPrinter({
                item,
                orderDeviceId,
                organizationId,
              })
            ).printerId ??
            kitchen?.printerId ??
            null;
        }
        if (!printerId) continue;
        const stationKey =
          kitchen?.mode === 'per_station'
            ? (item.productionStationId ?? '-')
            : '-';
        const key = `${printerId}::${stationKey}`;
        const bucket = buckets.get(key) ?? {
          printerId,
          stationName:
            kitchen?.mode === 'per_station'
              ? (item.productionStation?.name ?? null)
              : null,
          lines: [],
        };
        bucket.lines.push({ item, quantity: line.quantity });
        buckets.set(key, bucket);
      }

      for (const bucket of buckets.values()) {
        await this.printJobsService.createFromWorkflow(
          organizationId,
          bucket.printerId,
          null,
          data.order.id,
          1,
          {
            ...this.buildOrderPayload(data.order, staff),
            organization: orgPayload,
            created_at: new Date(),
            station_name: bucket.stationName,
            items: bucket.lines.map(({ item, quantity }) => ({
              quantity,
              name: item.productName,
              options: this.formatOptions(item),
            })),
            reason: data.reason ?? null,
            is_test: isTest,
          },
          null,
          CANCELLATION_TICKET_TEMPLATE,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to print cancellation ticket for org ${organizationId}: ${(error as Error).message}`,
      );
    }
  }

  private async getOrderFlow(
    organizationId: string,
  ): Promise<NonNullable<
    import('../../database/entities/organization.entity').OrganizationSettings['orderFlow']
  > | null> {
    const org = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: ['id', 'settings'],
    });
    return org?.settings?.orderFlow || null;
  }
}

/**
 * Betraege und Positionen einer Pfand-Auszahlung fuer die Vorlage
 * `pfand_return_receipt` (Betraege negativ, wie auf dem Gegenbeleg).
 */
export function pfandReturnPrintData(
  pfandReturn: Pick<
    PfandReturn,
    'id' | 'returnNumber' | 'createdAt' | 'lines' | 'totalAmount' | 'taxLines'
  >,
): Record<string, unknown> {
  const taxLines = pfandReturn.taxLines ?? [];
  return {
    pfand_return_id: pfandReturn.id,
    return_number: pfandReturn.returnNumber ?? null,
    created_at: pfandReturn.createdAt,
    items: (pfandReturn.lines ?? []).map((line) => ({
      quantity: line.quantity,
      name: line.name,
      unit_amount: Number(line.unitAmount),
      total: -Math.round(Number(line.unitAmount) * line.quantity * 100) / 100,
      vat_rate: line.vatRate ?? null,
    })),
    tax_lines: taxLines,
    tax_amount:
      Math.round(taxLines.reduce((sum, l) => sum + l.tax, 0) * 100) / 100,
    total: -Math.abs(Number(pfandReturn.totalAmount)),
    payment_method: 'cash',
    payment_label: paymentMethodLabel('cash'),
  };
}
