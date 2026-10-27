import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Event,
  EventInvoiceStatus,
  isInvoiceOverdue,
} from '../../database/entities/event.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { QueryAdminEventsDto, MarkInvoicedDto } from './dto/admin-events.dto';

export interface AdminEventListItem {
  id: string;
  name: string;
  organizationId: string;
  organizationName: string;
  startDate: Date | null;
  endDate: Date | null;
  status: string;
  billingStatus: string;
  orderCount: number;
  revenueTotal: number;
  invoicedAt: Date | null;
  invoicedBy: string | null;
  invoiceNote: string | null;
  /** Auf Rechnung ueber Stripe: die Rechnung. Leer bei Altfaellen (von Hand). */
  stripeInvoiceId: string | null;
  invoiceNumber: string | null;
  /** Stripes Status; `overdue` fuer offene Rechnungen nach dem Faelligkeitsdatum. */
  invoiceStatus: EventInvoiceStatus | 'overdue' | null;
  invoiceDueAt: Date | null;
  invoicePaidAt: Date | null;
  invoiceHostedUrl: string | null;
  invoiceHasPdf: boolean;
  priceCharged: number | null;
}

/**
 * Eine Zeile aus `getRawMany()`/`getRawOne()` der Eventliste. TypeORM
 * benennt die Spalten nach `<alias>_<spalte>`; COUNT und SUM kommen von
 * PostgreSQL als Zeichenkette zurueck.
 */
interface AdminEventRawRow {
  event_id: string;
  event_name: string;
  event_organization_id: string;
  event_start_date: Date | null;
  event_end_date: Date | null;
  event_status: string;
  event_billing_status: string;
  event_invoiced_at: Date | null;
  event_invoiced_by: string | null;
  event_invoice_note: string | null;
  event_stripe_invoice_id: string | null;
  event_stripe_invoice_number: string | null;
  event_invoice_status: EventInvoiceStatus | null;
  event_invoice_due_at: Date | null;
  event_invoice_paid_at: Date | null;
  event_invoice_hosted_url: string | null;
  event_invoice_pdf_url: string | null;
  event_price_charged: string | null;
  organizationName?: string | null;
  org_name?: string | null;
  orderCount?: string | null;
  revenueTotal?: string | null;
}

interface AdminEventOrderRawRow {
  id: string;
  orderNumber: string;
  status: string;
  totalAmount?: string | null;
}

@Injectable()
export class AdminEventsService {
  constructor(
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
  ) {}

  async findAllEvents(queryDto: QueryAdminEventsDto): Promise<{
    data: AdminEventListItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    const {
      search,
      status,
      from,
      to,
      invoiced,
      page = 1,
      limit = 20,
    } = queryDto;

    const qb = this.eventRepository
      .createQueryBuilder('event')
      .leftJoin('event.organization', 'org')
      .addSelect('org.name', 'org_name')
      .leftJoin('event.orders', 'order', 'order.status = :completedStatus', {
        completedStatus: 'completed',
      })
      .leftJoin(
        'order.payments',
        'payment',
        'payment.status = :capturedStatus',
        { capturedStatus: 'captured' },
      )
      .select([
        'event.id',
        'event.name',
        'event.organizationId',
        'event.startDate',
        'event.endDate',
        'event.status',
        'event.billingStatus',
        'event.invoicedAt',
        'event.invoicedBy',
        'event.invoiceNote',
        'event.stripeInvoiceId',
        'event.stripeInvoiceNumber',
        'event.invoiceStatus',
        'event.invoiceDueAt',
        'event.invoicePaidAt',
        'event.invoiceHostedUrl',
        'event.invoicePdfUrl',
        'event.priceCharged',
      ])
      .addSelect('org.name', 'organizationName')
      .addSelect('COUNT(DISTINCT order.id)', 'orderCount')
      .addSelect('COALESCE(SUM(payment.amount), 0)', 'revenueTotal')
      .groupBy('event.id')
      .addGroupBy('org.name');

    if (search) {
      qb.andWhere('(event.name ILIKE :search OR org.name ILIKE :search)', {
        search: `%${search}%`,
      });
    }

    if (status) {
      qb.andWhere('event.status = :status', { status });
    }

    if (from) {
      qb.andWhere('event.startDate >= :from', { from: new Date(from) });
    }

    if (to) {
      qb.andWhere('event.startDate <= :to', { to: new Date(to) });
    }

    if (invoiced === true) {
      qb.andWhere('event.invoicedAt IS NOT NULL');
    } else if (invoiced === false) {
      qb.andWhere('event.invoicedAt IS NULL');
    }

    // Count total without pagination
    const countQb = qb.clone();
    const rawCount = await countQb.getRawMany();
    const total = rawCount.length;

    const raw = await qb
      .orderBy('event.createdAt', 'DESC')
      .offset((page - 1) * limit)
      .limit(limit)
      .getRawMany<AdminEventRawRow>();

    const data: AdminEventListItem[] = raw.map((r) => this.toListItem(r));

    return { data, total, page, limit };
  }

  async getEvent(eventId: string): Promise<
    AdminEventListItem & {
      orders: {
        id: string;
        orderNumber: string;
        status: string;
        totalAmount: number;
      }[];
    }
  > {
    const qb = this.eventRepository
      .createQueryBuilder('event')
      .leftJoin('event.organization', 'org')
      .leftJoin('event.orders', 'order', 'order.status = :completedStatus', {
        completedStatus: 'completed',
      })
      .leftJoin(
        'order.payments',
        'payment',
        'payment.status = :capturedStatus',
        { capturedStatus: 'captured' },
      )
      .select([
        'event.id',
        'event.name',
        'event.organizationId',
        'event.startDate',
        'event.endDate',
        'event.status',
        'event.billingStatus',
        'event.invoicedAt',
        'event.invoicedBy',
        'event.invoiceNote',
        'event.stripeInvoiceId',
        'event.stripeInvoiceNumber',
        'event.invoiceStatus',
        'event.invoiceDueAt',
        'event.invoicePaidAt',
        'event.invoiceHostedUrl',
        'event.invoicePdfUrl',
        'event.priceCharged',
      ])
      .addSelect('org.name', 'organizationName')
      .addSelect('COUNT(DISTINCT order.id)', 'orderCount')
      .addSelect('COALESCE(SUM(payment.amount), 0)', 'revenueTotal')
      .where('event.id = :eventId', { eventId })
      .groupBy('event.id')
      .addGroupBy('org.name');

    const raw = await qb.getRawOne<AdminEventRawRow>();

    if (!raw) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.EVENT_NOT_FOUND,
        message: 'Event nicht gefunden',
      });
    }

    // Load orders summary separately (all orders, not just completed)
    const ordersRaw = await this.eventRepository
      .createQueryBuilder('event')
      .leftJoin('event.orders', 'order')
      .leftJoin(
        'order.payments',
        'payment',
        'payment.status = :capturedStatus',
        { capturedStatus: 'captured' },
      )
      .select('order.id', 'id')
      .addSelect('order.orderNumber', 'orderNumber')
      .addSelect('order.status', 'status')
      .addSelect('COALESCE(SUM(payment.amount), 0)', 'totalAmount')
      .where('event.id = :eventId', { eventId })
      .andWhere('order.id IS NOT NULL')
      .groupBy('order.id')
      .orderBy('order.createdAt', 'DESC')
      .getRawMany<AdminEventOrderRawRow>();

    const orders = ordersRaw.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      totalAmount: parseFloat(o.totalAmount ?? '0'),
    }));

    return { ...this.toListItem(raw), orders };
  }

  private toListItem(r: AdminEventRawRow): AdminEventListItem {
    const invoiceStatus: EventInvoiceStatus | 'overdue' | null =
      r.event_stripe_invoice_id
        ? isInvoiceOverdue({
            invoiceStatus: r.event_invoice_status,
            invoiceDueAt: r.event_invoice_due_at,
          })
          ? 'overdue'
          : (r.event_invoice_status ?? 'draft')
        : null;
    return {
      id: r.event_id,
      name: r.event_name,
      organizationId: r.event_organization_id,
      organizationName: r.organizationName ?? r.org_name ?? '',
      startDate: r.event_start_date,
      endDate: r.event_end_date,
      status: r.event_status,
      billingStatus: r.event_billing_status,
      orderCount: parseInt(r.orderCount ?? '0', 10),
      revenueTotal: parseFloat(r.revenueTotal ?? '0'),
      invoicedAt: r.event_invoiced_at,
      invoicedBy: r.event_invoiced_by,
      invoiceNote: r.event_invoice_note,
      stripeInvoiceId: r.event_stripe_invoice_id ?? null,
      invoiceNumber: r.event_stripe_invoice_number ?? null,
      invoiceStatus,
      invoiceDueAt: r.event_invoice_due_at ?? null,
      invoicePaidAt: r.event_invoice_paid_at ?? null,
      invoiceHostedUrl: r.event_invoice_hosted_url ?? null,
      invoiceHasPdf: !!r.event_invoice_pdf_url,
      priceCharged:
        r.event_price_charged !== null && r.event_price_charged !== undefined
          ? parseFloat(String(r.event_price_charged))
          : null,
    };
  }

  async markInvoiced(
    eventId: string,
    adminUserId: string,
    dto: MarkInvoicedDto,
  ): Promise<Event> {
    const event = await this.eventRepository.findOne({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.EVENT_NOT_FOUND,
        message: 'Event nicht gefunden',
      });
    }

    event.invoicedAt = new Date();
    event.invoicedBy = adminUserId;
    event.invoiceNote = dto.note ?? null;

    await this.eventRepository.save(event);
    return event;
  }

  async waive(eventId: string): Promise<Event> {
    const event = await this.eventRepository.findOne({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.EVENT_NOT_FOUND,
        message: 'Event nicht gefunden',
      });
    }

    event.billingStatus = 'waived';
    await this.eventRepository.save(event);
    return event;
  }

  async unmarkInvoiced(eventId: string): Promise<Event> {
    const event = await this.eventRepository.findOne({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.EVENT_NOT_FOUND,
        message: 'Event nicht gefunden',
      });
    }

    event.invoicedAt = null;
    event.invoicedBy = null;
    event.invoiceNote = null;

    await this.eventRepository.save(event);
    return event;
  }
}
