import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { isCashAllowed } from '../../common/utils/operating-mode.util';
import { HospitalityReceipt } from '../../database/entities/hospitality-receipt.entity';
import { OrderEvent } from '../../database/entities/order-event.entity';
import type { Organization } from '../../database/entities/organization.entity';
import { taxMasterData } from '../dsfinvk/dsfinvk-master';
import { OrderPrintService } from '../print-jobs/order-print.service';
import {
  SMALL_INVOICE_LIMIT,
  collectiveItemNames,
  dayKey,
  hospitalityBlocks,
  hospitalitySnapshot,
  missingIssuerData,
  printableBlocks,
  type HospitalityIssuer,
  type HospitalityMasterField,
  type HospitalitySnapshot,
} from './hospitality';
import type { ReceiptBlock } from './receipt-blocks';
import { ReceiptsService, type ReceiptActor } from './receipts.service';

export interface HospitalityIssueInput {
  orderIds: string[];
  recipientName?: string | null;
  recipientAddress?: string | null;
  /** Tag der Bewirtung (JJJJ-MM-TT); Standard: Tag der Bestellung. */
  serviceDate?: string | null;
}

/** Stand vor dem Ausstellen (fuer das Formular an der Kasse). */
export interface HospitalityCheck {
  existing: HospitalityReceiptView | null;
  total: number;
  tip: number;
  isTest: boolean;
  /** Ueber 250 €: Name des Bewirtenden Pflicht (Rn. 12). */
  recipientRequired: boolean;
  missingMasterData: HospitalityMasterField[];
  collectiveItems: string[];
  serviceDate: string;
  serviceDateMin: string;
  serviceDateMax: string;
}

export interface HospitalityReceiptView {
  id: string;
  number: string | null;
  isTest: boolean;
  issuedAt: string;
  serviceDate: string;
  recipientName: string | null;
  total: number;
  tip: number;
  orderIds: string[];
}

function issuerOf(org: Organization): HospitalityIssuer {
  const m = taxMasterData(org);
  const s = (org.settings ?? {}) as { legalName?: unknown };
  const billing = org.billingAddress;
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return {
    // Offizieller Name (Steuerangaben), sonst der Rechnungsempfaenger der
    // Bestellung bei OpenEOS; der Anzeigename allein reicht nicht.
    legalName: text(s.legalName) || text(billing?.company) || '',
    street: m.street || text(billing?.street),
    zip: m.zip || text(billing?.zip),
    city: m.city || text(billing?.city),
    taxNumber: m.taxNumber,
    vatId: m.vatId,
  };
}

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Bewirtungsbelege ausstellen und ausgeben (Druck, QR-Code, E-Mail).
 * Ausgestellt wird einmal je Bestellung(en); jede weitere Ausgabe ist eine
 * „Kopie“ desselben unveraenderlichen Datensatzes.
 */
@Injectable()
export class HospitalityReceiptsService {
  private readonly logger = new Logger(HospitalityReceiptsService.name);

  constructor(
    @InjectRepository(HospitalityReceipt)
    private readonly repository: Repository<HospitalityReceipt>,
    @InjectRepository(OrderEvent)
    private readonly orderEvents: Repository<OrderEvent>,
    private readonly dataSource: DataSource,
    private readonly receipts: ReceiptsService,
    private readonly orderPrintService: OrderPrintService,
  ) {}

  private async existingFor(
    organizationId: string,
    orderIds: string[],
  ): Promise<{ receipt: HospitalityReceipt; orderIds: string[] } | null> {
    const rows = await this.dataSource.query<
      { hospitality_receipt_id: string }[]
    >(
      `SELECT DISTINCT hospitality_receipt_id FROM hospitality_receipt_orders
        WHERE organization_id = $1 AND order_id = ANY($2::uuid[])`,
      [organizationId, orderIds],
    );
    if (rows.length === 0) return null;
    if (rows.length > 1) throw this.conflict();
    return this.load(organizationId, rows[0].hospitality_receipt_id);
  }

  private conflict() {
    return new ConflictException({
      code: ErrorCodes.HOSPITALITY_RECEIPT_EXISTS,
      message:
        'Für einen Teil dieser Bestellungen gibt es schon einen Bewirtungsbeleg. Gib ihn aus dem Verlauf der Bestellung erneut aus.',
    });
  }

  async load(
    organizationId: string,
    id: string,
  ): Promise<{ receipt: HospitalityReceipt; orderIds: string[] }> {
    const receipt = await this.repository.findOne({
      where: { id, organizationId },
    });
    if (!receipt) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.HOSPITALITY_RECEIPT_NOT_FOUND,
        message: 'Bewirtungsbeleg nicht gefunden',
      });
    }
    const rows = await this.dataSource.query<{ order_id: string }[]>(
      `SELECT order_id FROM hospitality_receipt_orders WHERE hospitality_receipt_id = $1`,
      [id],
    );
    return { receipt, orderIds: rows.map((r) => r.order_id) };
  }

  view(
    receipt: HospitalityReceipt,
    orderIds: string[],
  ): HospitalityReceiptView {
    return {
      id: receipt.id,
      number: receipt.number,
      isTest: receipt.isTest,
      issuedAt: new Date(receipt.issuedAt).toISOString(),
      serviceDate: receipt.serviceDate,
      recipientName: receipt.recipientName,
      total: Number(receipt.total),
      tip: Number(receipt.tip),
      orderIds,
    };
  }

  /** Kassenbelege, Zahlungen und Stammdaten fuer einen neuen Beleg. */
  private async prepare(organizationId: string, orderIds: string[]) {
    const { organization, timeZone, documents, payments } =
      await this.receipts.documents(organizationId, orderIds);
    const issuer = issuerOf(organization);
    const snapshot = hospitalitySnapshot({
      issuer,
      vatExempt: organization.settings?.vatExempt !== false,
      cashlessOnly: !isCashAllowed(organization),
      documents,
      payments: payments.map((p) => ({
        reference: p.providerTransactionId ?? null,
      })),
    });
    const firstDay = snapshot.receiptDate
      ? dayKey(snapshot.receiptDate, timeZone)
      : dayKey(new Date(), timeZone);
    return {
      organization,
      timeZone,
      issuer,
      snapshot,
      serviceDate: firstDay,
      serviceDateMin: addDays(firstDay, -1),
      serviceDateMax: dayKey(new Date(), timeZone),
    };
  }

  async check(
    organizationId: string,
    orderIds: string[],
  ): Promise<HospitalityCheck> {
    const existing = await this.existingFor(organizationId, orderIds);
    const p = await this.prepare(
      organizationId,
      existing ? existing.orderIds : orderIds,
    );
    return {
      existing: existing
        ? this.view(existing.receipt, existing.orderIds)
        : null,
      total: p.snapshot.total,
      tip: p.snapshot.tip,
      isTest: p.snapshot.isTest,
      recipientRequired: p.snapshot.total > SMALL_INVOICE_LIMIT,
      missingMasterData: missingIssuerData(p.issuer, p.snapshot.total),
      collectiveItems: collectiveItemNames(p.snapshot.items.map((i) => i.name)),
      serviceDate: p.serviceDate,
      serviceDateMin: p.serviceDateMin,
      serviceDateMax: p.serviceDateMax,
    };
  }

  /**
   * Bewirtungsbeleg ausstellen. Gibt es fuer genau diese Bestellungen schon
   * einen, kommt er zurueck (`existing: true`).
   */
  async issue(
    actor: ReceiptActor,
    input: HospitalityIssueInput,
  ): Promise<{ receipt: HospitalityReceiptView; existing: boolean }> {
    const orderIds = [...new Set(input.orderIds)];
    const existing = await this.existingFor(actor.organizationId, orderIds);
    if (existing) {
      const same =
        existing.orderIds.length === orderIds.length &&
        existing.orderIds.every((id) => orderIds.includes(id));
      if (!same) throw this.conflict();
      return {
        receipt: this.view(existing.receipt, existing.orderIds),
        existing: true,
      };
    }
    const p = await this.prepare(actor.organizationId, orderIds);
    const s = p.snapshot;

    const missing = missingIssuerData(p.issuer, s.total);
    if (missing.length) {
      throw new ConflictException({
        code: ErrorCodes.HOSPITALITY_MASTER_DATA_REQUIRED,
        message:
          'Für den Bewirtungsbeleg fehlen Angaben zu deinem Verein (offizieller Name, Anschrift und – über 250 € – Steuernummer oder USt-IdNr.). Trag sie in der Verwaltung unter Einstellungen → Organisation ein.',
        params: { missing: missing.join(',') },
      });
    }
    const collective = collectiveItemNames(s.items.map((i) => i.name));
    if (collective.length) {
      throw new ConflictException({
        code: ErrorCodes.HOSPITALITY_ITEMS_NOT_SPECIFIC,
        message: `Sammelbezeichnungen wie „${collective[0]}“ reichen auf einem Bewirtungsbeleg nicht. Benenne die Artikel einzeln (z. B. „Bratwurst“, „Apfelschorle“).`,
        params: { items: collective.join(', ') },
      });
    }
    const recipientName = input.recipientName?.trim() || null;
    const recipientAddress = input.recipientAddress?.trim() || null;
    if (s.total > SMALL_INVOICE_LIMIT && !recipientName) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.HOSPITALITY_RECIPIENT_REQUIRED,
        message:
          'Über 250 € muss der Name des Bewirtenden (Person oder Firma) auf dem Beleg stehen.',
        params: { limit: SMALL_INVOICE_LIMIT },
      });
    }
    const serviceDate = input.serviceDate?.trim() || p.serviceDate;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate) ||
      serviceDate < p.serviceDateMin ||
      serviceDate > p.serviceDateMax
    ) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.HOSPITALITY_SERVICE_DATE_INVALID,
        message: 'Der Tag der Bewirtung passt nicht zur Bestellung.',
        params: { min: p.serviceDateMin, max: p.serviceDateMax },
      });
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const row = manager.create(HospitalityReceipt, {
        organizationId: actor.organizationId,
        isTest: s.isTest,
        issuedAt: new Date(),
        serviceDate,
        recipientName,
        recipientAddress,
        total: s.total.toFixed(2),
        tip: s.tip.toFixed(2),
        snapshot: s as unknown as Record<string, unknown>,
        deviceId: actor.deviceId,
        userId: actor.userId,
        waiterId: actor.waiterId ?? null,
        actorName: actor.actorName ?? null,
      });
      const inserted = await manager.save(row);
      try {
        await manager.query(
          `INSERT INTO hospitality_receipt_orders (order_id, hospitality_receipt_id, organization_id)
           SELECT unnest($1::uuid[]), $2, $3`,
          [orderIds, inserted.id, actor.organizationId],
        );
      } catch (error) {
        // Gleichzeitig an zwei Kassen: PK auf order_id.
        if ((error as { code?: string }).code === '23505')
          throw this.conflict();
        throw error;
      }
      await manager.save(
        orderIds.map((orderId) =>
          manager.create(OrderEvent, {
            organizationId: actor.organizationId,
            orderId,
            type: 'hospitality_receipt_issued',
            deviceId: actor.deviceId,
            userId: actor.userId,
            waiterId: actor.waiterId ?? null,
            actorName: actor.actorName ?? null,
            data: {
              hospitalityReceiptId: inserted.id,
              number: inserted.number,
            },
          }),
        ),
      );
      // Nummer kommt aus dem Trigger.
      return manager.findOneOrFail(HospitalityReceipt, {
        where: { id: inserted.id },
      });
    });
    this.logger.log(
      `Bewirtungsbeleg ${saved.number ?? '(Test)'} für Org ${actor.organizationId} ausgestellt`,
    );
    return { receipt: this.view(saved, orderIds), existing: false };
  }

  // ------------------------------------------------------------- Ausgabe

  /** Erste Ausgabe = Original, jede weitere = Kopie. */
  private async nextIsCopy(receipt: HospitalityReceipt, orderIds: string[]) {
    const n = await this.orderEvents.count({
      where: { orderId: In(orderIds), type: 'hospitality_receipt_output' },
    });
    void receipt;
    return n > 0;
  }

  private async recordOutput(
    actor: ReceiptActor,
    receipt: HospitalityReceipt,
    orderIds: string[],
    channel: 'print' | 'qr' | 'email',
    copy: boolean,
    extra: Record<string, unknown> = {},
  ) {
    await this.orderEvents.save(
      orderIds.map((orderId) =>
        this.orderEvents.create({
          organizationId: actor.organizationId,
          orderId,
          type: 'hospitality_receipt_output',
          deviceId: actor.deviceId,
          userId: actor.userId,
          waiterId: actor.waiterId ?? null,
          actorName: actor.actorName ?? null,
          data: { number: receipt.number, channel, copy, ...extra },
        }),
      ),
    );
  }

  blocksFor(
    receipt: HospitalityReceipt,
    copy: boolean,
    timeZone?: string,
  ): ReceiptBlock[] {
    return hospitalityBlocks(
      {
        number: receipt.number,
        issuedAt: receipt.issuedAt,
        serviceDate: receipt.serviceDate,
        recipientName: receipt.recipientName,
        recipientAddress: receipt.recipientAddress,
        snapshot: receipt.snapshot as unknown as HospitalitySnapshot,
      },
      { copy, timeZone },
    );
  }

  async print(
    actor: ReceiptActor,
    id: string,
  ): Promise<{ printed: boolean; copy: boolean }> {
    const { receipt, orderIds } = await this.load(actor.organizationId, id);
    const copy = await this.nextIsCopy(receipt, orderIds);
    const printed = await this.orderPrintService.printHospitalityReceipt(
      actor.organizationId,
      {
        deviceId: actor.deviceId,
        orderId: orderIds[0] ?? null,
        isTest: receipt.isTest,
        blocks: printableBlocks(this.blocksFor(receipt, copy)),
      },
    );
    if (printed)
      await this.recordOutput(actor, receipt, orderIds, 'print', copy);
    return { printed, copy };
  }

  async link(
    actor: ReceiptActor,
    id: string,
  ): Promise<{ url: string; expiresAt: string; copy: boolean }> {
    const { receipt, orderIds } = await this.load(actor.organizationId, id);
    const copy = await this.nextIsCopy(receipt, orderIds);
    const link = await this.receipts.saveLink(actor, orderIds, {
      kind: 'hospitality',
      hospitalityReceiptId: receipt.id,
      copy,
    });
    await this.recordOutput(actor, receipt, orderIds, 'qr', copy);
    return { url: link.url, expiresAt: link.expiresAt.toISOString(), copy };
  }

  async email(
    actor: ReceiptActor,
    id: string,
    email: string,
  ): Promise<{ sent: true; copy: boolean }> {
    const { receipt, orderIds } = await this.load(actor.organizationId, id);
    const copy = await this.nextIsCopy(receipt, orderIds);
    await this.receipts.sendBlocksByEmail(actor, orderIds, email, {
      label: 'Bewirtungsbeleg',
      filename: `Bewirtungsbeleg-${receipt.number ?? 'TEST'}.pdf`,
      link: { kind: 'hospitality', hospitalityReceiptId: receipt.id, copy },
      pages: (timeZone) => [this.blocksFor(receipt, copy, timeZone)],
    });
    await this.recordOutput(actor, receipt, orderIds, 'email', copy);
    return { sent: true, copy };
  }
}
