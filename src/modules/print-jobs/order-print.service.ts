import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Device } from '../../database/entities/device.entity';
import { Organization } from '../../database/entities/organization.entity';
import { OrderItem } from '../../database/entities/order-item.entity';
import { PrintJobsService } from './print-jobs.service';
import { PrintRoutingService } from './print-routing.service';

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
    private readonly printJobsService: PrintJobsService,
    private readonly printRoutingService: PrintRoutingService,
  ) {}

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
  private buildOrderPayload(order: any): Record<string, unknown> {
    if (!order) return {};
    return {
      order_id: order.id,
      order_number: order.orderNumber,
      daily_number: order.dailyNumber ?? null,
      table_number: order.tableNumber ?? null,
      customer_name: order.customerName ?? null,
      priority: order.priority ?? 'normal',
      created_at: order.createdAt ?? null,
      // Pass the raw entity too in case a template wants nested access.
      order,
    };
  }

  async handleOrderCreated(
    organizationId: string,
    data: {
      order: any;
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
        );
      }

      // Order ticket on order creation (always per_order)
      const orderTicket = orderFlow.orderTicketPrinting;
      if (orderTicket?.enabled) {
        const { printerId } = await this.printRoutingService.resolveOrderPrinter({
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
              ...this.buildOrderPayload(data.order),
              total: data.total,
              source: data.source,
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
      order: any;
      orderId: string;
      orderNumber: string;
      tableNumber?: string | null;
      total: number;
      source: string;
    },
  ): Promise<void> {
    const { mode, templateId } = kitchen;

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
          ...this.buildOrderPayload(data.order),
          total: data.total,
          source: data.source,
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
        const { printerId } = await this.printRoutingService.resolveItemPrinter({
          item,
          orderDeviceId,
          organizationId,
        });
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
            ...this.buildOrderPayload(data.order),
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
          },
          item.id,
          'kitchen_ticket',
        );
      }
      return;
    }

    if (mode === 'per_station') {
      // Group items by *resolved* printerId (cascade-aware).
      type Bucket = {
        printerId: string;
        stationName: string | null;
        stationId: string | null;
        items: OrderItem[];
      };
      const buckets = new Map<string, Bucket>();
      const fallbackBucketKey = '__fallback__';

      for (const item of items) {
        const { printerId } = await this.printRoutingService.resolveItemPrinter({
          item,
          orderDeviceId,
          organizationId,
        });
        const resolvedPrinterId = printerId ?? kitchen.orgFallbackPrinterId;
        if (!resolvedPrinterId) {
          this.logger.warn(
            `No printer resolved for kitchen per_station item ${item.id} (order ${data.orderId}, org ${organizationId}); skipping`,
          );
          continue;
        }
        const key = printerId ? resolvedPrinterId : fallbackBucketKey;
        const station = item.productionStation;
        const existing = buckets.get(key);
        if (existing) {
          existing.items.push(item);
        } else {
          buckets.set(key, {
            printerId: resolvedPrinterId,
            stationName: station?.name ?? (printerId ? null : 'Sonstiges'),
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
            ...this.buildOrderPayload(data.order),
            station_name: bucket.stationName,
            station_id: bucket.stationId,
            items: bucket.items.map((it) => ({
              quantity: it.quantity,
              name: it.productName,
              notes: it.notes ?? null,
              kitchen_notes: it.kitchenNotes ?? null,
              options: this.formatOptions(it),
            })),
          },
          null,
          'kitchen_ticket',
        );
      }
    }
  }

  private formatOptions(item: OrderItem): string[] {
    const selected = (item.options as { selected?: Array<{ option?: string }> } | null)?.selected ?? [];
    return selected.map((o) => o.option ?? '').filter(Boolean);
  }

  async handlePaymentReceived(
    organizationId: string,
    data: {
      orderId: string;
      orderNumber: string;
      paymentId: string;
      amount: number;
      paymentMethod: string;
      isFullyPaid: boolean;
      order: any;
    },
  ): Promise<void> {
    try {
      const orderFlow = (await this.getOrderFlow(organizationId)) ?? {};
      const orderDeviceId: string | null =
        data.order?.createdByDeviceId ?? null;

      // Receipt printing on payment.
      const receipt = orderFlow.receiptPrinting;
      const trigger = receipt?.trigger ?? 'payment_received';
      if (receipt?.enabled !== false && trigger === 'payment_received') {
        const { printerId } = await this.printRoutingService.resolveOrderPrinter({
          organizationId,
          orderDeviceId,
          workflow: 'receipt',
        });
        if (printerId) {
          // Receipt template needs organization + monetary detail. Load org once.
          const org = await this.organizationRepository.findOne({
            where: { id: organizationId },
            select: ['id', 'name', 'settings'],
          });
          const orgPayload = org
            ? {
                name: org.name,
                address: org.settings?.address
                  ? `${org.settings.address.street}, ${org.settings.address.zip} ${org.settings.address.city}`
                  : undefined,
                phone: org.settings?.contact?.phone,
              }
            : undefined;
          await this.printJobsService.createFromWorkflow(
            organizationId,
            printerId,
            receipt?.templateId || null,
            data.orderId,
            1,
            {
              ...this.buildOrderPayload(data.order),
              organization: orgPayload,
              total: data.order?.total,
              subtotal: data.order?.subtotal,
              tax_amount: data.order?.taxAmount,
              tax_rate: data.order?.taxRate,
              paid_amount: data.order?.paidAmount,
              change: data.order?.change,
              payment_method: data.paymentMethod,
              paymentId: data.paymentId,
              amount: data.amount,
              isFullyPaid: data.isFullyPaid,
            },
            null,
            'receipt',
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Failed to handle payment received printing for org ${organizationId}: ${(error as Error).message}`,
      );
    }
  }

  private async getOrderFlow(
    organizationId: string,
  ): Promise<
    NonNullable<
      import('../../database/entities/organization.entity').OrganizationSettings['orderFlow']
    > | null
  > {
    const org = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: ['id', 'settings'],
    });
    return org?.settings?.orderFlow || null;
  }
}
