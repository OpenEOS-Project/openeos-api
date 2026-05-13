import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Device } from '../../database/entities/device.entity';
import { OrderItem } from '../../database/entities/order-item.entity';
import { Organization } from '../../database/entities/organization.entity';
import { ProductionStation } from '../../database/entities/production-station.entity';

export type ItemPrinterSource = 'product' | 'category' | 'device' | 'org' | null;
export type OrderPrinterSource = 'device' | 'org' | null;
export type OrderWorkflow = 'kitchen' | 'receipt' | 'order_ticket';

export interface ResolveItemPrinterInput {
  /** Already loaded with `product` and `product.category` relations preferred. */
  item: OrderItem;
  orderDeviceId: string | null;
  organizationId: string;
}

export interface ResolveItemPrinterResult {
  printerId: string | null;
  source: ItemPrinterSource;
}

export interface ResolveOrderPrinterInput {
  organizationId: string;
  orderDeviceId: string | null;
  workflow: OrderWorkflow;
}

export interface ResolveOrderPrinterResult {
  printerId: string | null;
  source: OrderPrinterSource;
}

/**
 * Centralized resolver that answers "which printer prints THIS line item /
 * receipt?" for live orders, reprints, and any future caller. Implements the
 * cascade: Product station → Category station → Device default → Org-level
 * override → null (skip).
 */
@Injectable()
export class PrintRoutingService {
  private readonly logger = new Logger(PrintRoutingService.name);

  constructor(
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(ProductionStation)
    private readonly productionStationRepository: Repository<ProductionStation>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepository: Repository<OrderItem>,
  ) {}

  /**
   * Resolve the printer for a single line item using the full cascade.
   *
   * Cascade:
   * 1. Item snapshot station (product- or category-derived at item-creation time)
   * 2. Device default printer (orderDeviceId.settings.defaultPrinterId)
   * 3. Organization-level kitchenTicketPrinting.printerId
   * 4. null
   *
   * Special case: when device.settings.printerMode === 'fixed', step 1 is
   * skipped — the device always prints to its own defaultPrinterId, falling
   * back to org-level only when missing.
   */
  async resolveItemPrinter(
    input: ResolveItemPrinterInput,
  ): Promise<ResolveItemPrinterResult> {
    const { item, orderDeviceId, organizationId } = input;

    // Load device once — needed for both printerMode check and step 2 fallback.
    const device = orderDeviceId
      ? await this.deviceRepository.findOne({
          where: { id: orderDeviceId },
          select: ['id', 'settings'],
        })
      : null;

    const printerMode = device?.settings?.printerMode;
    const isFixed = printerMode === 'fixed';

    // Step 1: item-time routing (skipped when device is in fixed mode)
    if (!isFixed && item.productionStationId) {
      const station = await this.productionStationRepository.findOne({
        where: { id: item.productionStationId },
        select: ['id', 'printerId'],
      });
      if (station?.printerId) {
        const productStationId = item.product?.productionStationId;
        // If product is loaded and the snapshot matches the product's current
        // station, treat as 'product' source; otherwise 'category'. When the
        // product relation isn't loaded, default to 'product'.
        const source: ItemPrinterSource =
          item.product === undefined || item.product === null
            ? 'product'
            : productStationId === item.productionStationId
              ? 'product'
              : 'category';
        return { printerId: station.printerId, source };
      }
    }

    // Step 2: device default printer
    const deviceDefault = device?.settings?.defaultPrinterId;
    if (deviceDefault) {
      return { printerId: String(deviceDefault), source: 'device' };
    }

    // Step 3: org-level kitchen printer
    const org = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: ['id', 'settings'],
    });
    const orgPrinterId =
      org?.settings?.orderFlow?.kitchenTicketPrinting?.printerId ?? null;
    if (orgPrinterId) {
      return { printerId: String(orgPrinterId), source: 'org' };
    }

    return { printerId: null, source: null };
  }

  /**
   * Resolve the printer for a whole-order workflow (kitchen ticket, receipt,
   * or order ticket).
   */
  async resolveOrderPrinter(
    input: ResolveOrderPrinterInput,
  ): Promise<ResolveOrderPrinterResult> {
    const { organizationId, orderDeviceId, workflow } = input;

    if (workflow === 'order_ticket') {
      // Order tickets are usually shop-side — no device fallback.
      const org = await this.organizationRepository.findOne({
        where: { id: organizationId },
        select: ['id', 'settings'],
      });
      const orgPrinterId =
        org?.settings?.orderFlow?.orderTicketPrinting?.printerId ?? null;
      if (orgPrinterId) {
        return { printerId: String(orgPrinterId), source: 'org' };
      }
      return { printerId: null, source: null };
    }

    // kitchen + receipt: device.defaultPrinterId → org-level override
    const device = orderDeviceId
      ? await this.deviceRepository.findOne({
          where: { id: orderDeviceId },
          select: ['id', 'settings'],
        })
      : null;

    const deviceDefault = device?.settings?.defaultPrinterId;
    if (deviceDefault) {
      return { printerId: String(deviceDefault), source: 'device' };
    }

    const org = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: ['id', 'settings'],
    });
    const orderFlow = org?.settings?.orderFlow;
    const orgPrinterId =
      workflow === 'kitchen'
        ? orderFlow?.kitchenTicketPrinting?.printerId ?? null
        : orderFlow?.receiptPrinting?.printerId ?? null;

    if (orgPrinterId) {
      return { printerId: String(orgPrinterId), source: 'org' };
    }

    return { printerId: null, source: null };
  }
}
