import { createHash, randomBytes } from 'crypto';
import * as QRCode from 'qrcode';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Not, Repository } from 'typeorm';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  OPERATING_MODE_SELECT,
  isOrdersOnly,
} from '../../common/utils/operating-mode.util';
import { DeploymentService } from '../../common/services/deployment.service';
import { Order, PaymentStatus } from '../../database/entities/order.entity';
import { OrderEvent } from '../../database/entities/order-event.entity';
import { Organization } from '../../database/entities/organization.entity';
import {
  Payment,
  PaymentTransactionStatus,
} from '../../database/entities/payment.entity';
import { PrintTemplate } from '../../database/entities/print-template.entity';
import { ReceiptLink } from '../../database/entities/receipt-link.entity';
import { HospitalityReceipt } from '../../database/entities/hospitality-receipt.entity';
import { hospitalityBlocks, type HospitalitySnapshot } from './hospitality';
import { EmailService } from '../email/email.service';
import { resolveOrderTimeZone } from '../orders/order-numbering';
import {
  toPublicLegalInfo,
  type PublicLegalInfo,
} from '../organizations/legal/legal-settings.util';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { TseSigningService } from '../tse/tse-signing.service';
import { receiptBlocks, type ReceiptBlock } from './receipt-blocks';
import {
  receiptDocumentFromPayload,
  type ReceiptDocument,
} from './receipt-document';
import { receiptMail } from './receipt-mail';
import { renderReceiptPdf } from './receipt-pdf';

/** Wer den Beleg an der Kasse ausgibt (fuer Verlauf und Versandgrenze). */
export interface ReceiptActor {
  organizationId: string;
  deviceId: string | null;
  userId: string | null;
  waiterId?: string | null;
  actorName?: string | null;
}

/** Ein Beleg auf der oeffentlichen Seite. */
export interface PublicReceipt {
  kind: 'receipt' | 'hospitality';
  orderNumber: string;
  isTest: boolean;
  blocks: ReceiptBlock[];
}

export interface PublicReceiptView {
  organizationName: string;
  expiresAt: string;
  receipts: PublicReceipt[];
  legal: PublicLegalInfo;
}

/** Zusatz eines Links auf einen Bewirtungsbeleg. */
export interface ReceiptLinkExtra {
  kind: 'hospitality';
  hospitalityReceiptId: string;
  copy: boolean;
}

/** Hoechstens so viele Bestellungen in einem Link (Tisch mit mehreren Bons). */
export const MAX_RECEIPT_ORDERS = 20;

/** Zahlungen, zu denen es einen Kassenbeleg gibt. */
const RECEIPT_PAYMENT_STATES = [
  PaymentTransactionStatus.CAPTURED,
  PaymentTransactionStatus.AUTHORIZED,
  PaymentTransactionStatus.REFUNDED,
];

/** Token: 128 Bit Zufall, base64url (22 Zeichen). */
export function newReceiptToken(): string {
  return randomBytes(16).toString('base64url');
}

export function receiptTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Nur Tokens in der Form, die `newReceiptToken` erzeugt. */
export function isReceiptToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(token);
}

function intEnv(
  config: ConfigService,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = config.get<string | number>(key);
  const value = typeof raw === 'number' ? raw : Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Einfache Pruefung der Form (der DTO prueft mit IsEmail vorher). */
export function isPlausibleEmail(value: string): boolean {
  return (
    value.length <= 254 &&
    /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/.test(
      value,
    )
  );
}

/**
 * Digitaler Beleg nach der Zahlung (Belegausgabepflicht § 146a Abs. 2 AO):
 * QR-Code mit Link auf eine oeffentliche Seite, Versand per E-Mail, PDF.
 * Inhalt = gedruckter Bon (`OrderPrintService.receiptPayload`).
 *
 * Datenschutz: Die E-Mail-Adresse des Gastes wird nur fuer den Versand
 * verwendet — nicht gespeichert, nicht protokolliert (auch nicht als
 * Hash). Im Verlauf der Bestellung steht nur „Beleg per E-Mail“ mit Zeit,
 * Geraet und Ergebnis.
 */
@Injectable()
export class ReceiptsService {
  private readonly logger = new Logger(ReceiptsService.name);
  /** Gueltigkeit eines Beleg-Links (Tage). */
  readonly linkDays: number;
  /** Beleg-Mails je Geraet und Stunde. */
  readonly deviceMailsPerHour: number;
  /** Beleg-Mails je Bestellung (insgesamt). */
  readonly mailsPerOrder: number;
  private readonly appUrl: string;

  constructor(
    @InjectRepository(ReceiptLink)
    private readonly linkRepository: Repository<ReceiptLink>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(PrintTemplate)
    private readonly templateRepository: Repository<PrintTemplate>,
    @InjectRepository(OrderEvent)
    private readonly orderEventRepository: Repository<OrderEvent>,
    @InjectRepository(HospitalityReceipt)
    private readonly hospitalityRepository: Repository<HospitalityReceipt>,
    private readonly orderPrintService: OrderPrintService,
    private readonly emailService: EmailService,
    private readonly deployment: DeploymentService,
    config: ConfigService,
    @Optional() private readonly tseSigning?: TseSigningService,
  ) {
    this.linkDays = intEnv(config, 'RECEIPT_LINK_DAYS', 90, 1, 365);
    this.deviceMailsPerHour = intEnv(
      config,
      'RECEIPT_EMAIL_DEVICE_LIMIT_PER_HOUR',
      30,
      1,
      1000,
    );
    this.mailsPerOrder = intEnv(config, 'RECEIPT_EMAIL_ORDER_LIMIT', 5, 1, 50);
    this.appUrl = (
      config.get<string>('APP_URL') || 'https://app.openeos.de'
    ).replace(/\/+$/, '');
  }

  // ---------------------------------------------------------------- Laden

  private notAvailable(message = 'Zu dieser Bestellung gibt es keinen Beleg') {
    return new ConflictException({
      code: ErrorCodes.RECEIPT_NOT_AVAILABLE,
      message,
    });
  }

  private async organization(organizationId: string): Promise<Organization> {
    const org = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: { ...OPERATING_MODE_SELECT, name: true, billingAddress: true },
    });
    if (!org) throw this.notAvailable();
    return org;
  }

  /**
   * Druckt die Bon-Vorlage der Organisation die Bedienung? Gilt die im
   * Kassenbon-Ablauf gewaehlte Vorlage, sonst eine eigene Vorlage vom Typ
   * `receipt` (die mitgelieferte druckt keine Bedienung).
   */
  async templateShowsWaiter(org: Organization): Promise<boolean> {
    const templateId = org.settings?.orderFlow?.receiptPrinting?.templateId;
    const template = templateId
      ? await this.templateRepository.findOne({
          where: { id: templateId, organizationId: org.id },
        })
      : await this.templateRepository.findOne({
          where: { organizationId: org.id, type: 'receipt' as never },
          order: { updatedAt: 'DESC' },
        });
    const source = template?.template as
      | { generatedTemplate?: string }
      | string
      | null
      | undefined;
    const text =
      typeof source === 'string' ? source : (source?.generatedTemplate ?? '');
    return /\bwaiter(_short)?_name\b/.test(text);
  }

  /**
   * Die Kassenbelege der Bestellungen (je Bestellung die letzte Zahlung,
   * wie der Nachdruck an der Kasse). Wirft RECEIPT_NOT_AVAILABLE in der
   * Betriebsart „Nur Bons“ (dort gibt es keine Kassenbons), fuer fremde
   * oder unbezahlte Bestellungen.
   */
  async documents(
    organizationId: string,
    orderIds: string[],
  ): Promise<{
    organization: Organization;
    timeZone: string;
    documents: ReceiptDocument[];
    /** Je Bestellung die Zahlung des Belegs (gleiche Reihenfolge). */
    payments: Payment[];
  }> {
    const ids = [...new Set(orderIds)];
    if (ids.length === 0 || ids.length > MAX_RECEIPT_ORDERS) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.RECEIPT_ORDERS_INVALID,
        message: `Bitte 1 bis ${MAX_RECEIPT_ORDERS} Bestellungen angeben.`,
      });
    }
    const organization = await this.organization(organizationId);
    if (isOrdersOnly(organization)) {
      throw this.notAvailable(
        'In der Betriebsart „Nur Bons“ gibt es keine Kassenbelege.',
      );
    }
    const orders = await this.orderRepository.find({
      where: { id: In(ids), organizationId },
    });
    if (orders.length !== ids.length) throw this.notAvailable();
    const byId = new Map(orders.map((o) => [o.id, o]));
    const showWaiter = await this.templateShowsWaiter(organization);
    const documents: ReceiptDocument[] = [];
    const payments: Payment[] = [];
    for (const id of ids) {
      const order = byId.get(id)!;
      const payment = await this.paymentRepository.findOne({
        where: { orderId: id, status: In(RECEIPT_PAYMENT_STATES) },
        order: { createdAt: 'DESC' },
      });
      if (!payment) throw this.notAvailable();
      payments.push(payment);
      const tse = (await this.tseSigning?.forPayment(payment.id)) ?? null;
      const payload = await this.orderPrintService.receiptPayload(
        organizationId,
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          paymentId: payment.id,
          amount: Number(payment.amount),
          paymentMethod: payment.paymentMethod,
          isFullyPaid: order.paymentStatus === PaymentStatus.PAID,
          order,
          amountReceived: payment.metadata?.amountReceived,
          tse,
        },
      );
      documents.push(receiptDocumentFromPayload(payload, { showWaiter }));
    }
    return {
      organization,
      timeZone: resolveOrderTimeZone(organization.settings?.timezone),
      documents,
      payments,
    };
  }

  // ---------------------------------------------------------------- Link

  async saveLink(
    actor: ReceiptActor,
    orderIds: string[],
    extra: ReceiptLinkExtra | null = null,
  ): Promise<{ url: string; token: string; expiresAt: Date }> {
    const token = newReceiptToken();
    const expiresAt = new Date(Date.now() + this.linkDays * 86_400_000);
    await this.linkRepository.insert({
      organizationId: actor.organizationId,
      tokenHash: receiptTokenHash(token),
      orderIds: [...new Set(orderIds)],
      createdByDeviceId: actor.deviceId,
      createdByUserId: actor.userId,
      expiresAt,
      ...(extra ?? {}),
    });
    return { url: `${this.appUrl}/beleg/${token}`, token, expiresAt };
  }

  private async recordEvents(
    actor: ReceiptActor,
    orderIds: string[],
    type: 'receipt_link_created' | 'receipt_emailed',
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.orderEventRepository.save(
      [...new Set(orderIds)].map((orderId) =>
        this.orderEventRepository.create({
          organizationId: actor.organizationId,
          orderId,
          type,
          deviceId: actor.deviceId,
          userId: actor.userId,
          waiterId: actor.waiterId ?? null,
          actorName: actor.actorName ?? null,
          data,
        }),
      ),
    );
  }

  /** QR-Code an der Kasse: Link auf den Beleg (gueltig `linkDays` Tage). */
  async createLink(
    actor: ReceiptActor,
    orderIds: string[],
  ): Promise<{ url: string; expiresAt: string }> {
    await this.documents(actor.organizationId, orderIds);
    const link = await this.saveLink(actor, orderIds);
    await this.recordEvents(actor, orderIds, 'receipt_link_created', {
      expiresAt: link.expiresAt.toISOString(),
    });
    return { url: link.url, expiresAt: link.expiresAt.toISOString() };
  }

  // ---------------------------------------------------------------- Mail

  private rateLimited(message: string, params: Record<string, number>) {
    return new HttpException(
      {
        code: ErrorCodes.RECEIPT_EMAIL_RATE_LIMITED,
        message,
        params,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Versandgrenzen: je Geraet und Stunde, je Bestellung insgesamt. */
  async assertMailAllowed(
    actor: ReceiptActor,
    orderIds: string[],
  ): Promise<void> {
    if (actor.deviceId) {
      const recent = await this.orderEventRepository.count({
        where: {
          type: 'receipt_emailed',
          deviceId: actor.deviceId,
          createdAt: MoreThan(new Date(Date.now() - 3_600_000)),
        },
      });
      if (recent >= this.deviceMailsPerHour) {
        throw this.rateLimited(
          'Von dieser Kasse wurden in der letzten Stunde zu viele Belege per E-Mail verschickt.',
          { limit: this.deviceMailsPerHour },
        );
      }
    }
    const perOrder = await this.orderEventRepository
      .createQueryBuilder('e')
      .select('e.order_id', 'orderId')
      .addSelect('count(*)::int', 'n')
      .where('e.type = :type', { type: 'receipt_emailed' })
      .andWhere('e.order_id IN (:...ids)', { ids: [...new Set(orderIds)] })
      .groupBy('e.order_id')
      .getRawMany<{ orderId: string; n: number }>();
    if (perOrder.some((row) => Number(row.n) >= this.mailsPerOrder)) {
      throw this.rateLimited(
        'Zu dieser Bestellung wurde der Beleg schon oft per E-Mail verschickt.',
        { limit: this.mailsPerOrder },
      );
    }
  }

  /** Antwortadresse: Kontakt des Vereins (Einstellungen), sonst keine. */
  private replyTo(org: Organization): string | undefined {
    const candidates = [
      org.settings?.contact?.email,
      org.settings?.legal?.contactEmail,
    ];
    return candidates
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .find((v) => v && isPlausibleEmail(v));
  }

  /**
   * Beleg per E-Mail (HTML + PDF). Die Adresse wird nur fuer den Versand
   * verwendet und danach verworfen.
   */
  async sendEmail(
    actor: ReceiptActor,
    orderIds: string[],
    email: string,
  ): Promise<{ sent: true }> {
    const address = email.trim();
    if (!isPlausibleEmail(address)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.RECEIPT_EMAIL_INVALID,
        message: 'Bitte gib eine gültige E-Mail-Adresse ein.',
      });
    }
    await this.assertMailAllowed(actor, orderIds);
    const { timeZone, documents } = await this.documents(
      actor.organizationId,
      orderIds,
    );
    await this.sendBlocksByEmail(actor, orderIds, address, {
      label: 'Kassenbeleg',
      filename: `Beleg-${documents[0].orderNumber}.pdf`,
      link: null,
      pages: () => documents.map((doc) => receiptBlocks(doc, timeZone)),
      checked: true,
    });
    return { sent: true };
  }

  /**
   * Beleg-Bausteine per Mail (Kassen- oder Bewirtungsbeleg): Adresse und
   * Grenzen pruefen, Link anlegen, senden, Ergebnis ohne Adresse im
   * Verlauf der Bestellung.
   */
  async sendBlocksByEmail(
    actor: ReceiptActor,
    orderIds: string[],
    email: string,
    options: {
      label: string;
      filename: string;
      link: ReceiptLinkExtra | null;
      pages: (timeZone: string) => ReceiptBlock[][];
      /** Adresse und Grenzen schon geprueft. */
      checked?: boolean;
    },
  ): Promise<void> {
    const address = email.trim();
    if (!options.checked) {
      if (!isPlausibleEmail(address)) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.RECEIPT_EMAIL_INVALID,
          message: 'Bitte gib eine gültige E-Mail-Adresse ein.',
        });
      }
      await this.assertMailAllowed(actor, orderIds);
    }
    const organization = await this.organization(actor.organizationId);
    const timeZone = resolveOrderTimeZone(organization.settings?.timezone);
    const link = await this.saveLink(actor, orderIds, options.link);
    const ok = await this.deliver({
      to: address,
      organization,
      label: options.label,
      pages: options.pages(timeZone),
      linkUrl: link.url,
      linkExpiresAt: link.expiresAt,
      filename: options.filename,
    });
    await this.recordEvents(actor, orderIds, 'receipt_emailed', {
      status: ok ? 'sent' : 'failed',
      kind: options.link?.kind ?? 'receipt',
    });
    if (!ok) {
      throw new HttpException(
        {
          code: ErrorCodes.RECEIPT_EMAIL_FAILED,
          message: 'Die E-Mail konnte nicht verschickt werden.',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  /** Mail mit Beleg-Bausteinen, PDF und QR-Bildern verschicken. */
  async deliver(input: {
    to: string;
    organization: Organization;
    label: string;
    pages: ReceiptBlock[][];
    linkUrl: string;
    linkExpiresAt: Date;
    filename: string;
  }): Promise<boolean> {
    const qrValues = [
      ...new Set(
        input.pages.flatMap((blocks) =>
          blocks.flatMap((b) => (b.type === 'qr' ? [b.value] : [])),
        ),
      ),
    ];
    const cids = new Map(qrValues.map((v, i) => [v, `tse-qr-${i + 1}`]));
    const legal = toPublicLegalInfo(
      input.organization,
      this.deployment.platformLegal,
    );
    const mail = receiptMail(
      {
        organizationName: input.organization.name,
        receipts: input.pages,
        label: input.label,
        linkUrl: input.linkUrl,
        linkExpiresAt: input.linkExpiresAt,
        imprintUrl: legal.imprintUrl,
        privacyUrl: legal.privacyUrl,
      },
      (value) => cids.get(value) ?? null,
    );
    const pdf = await renderReceiptPdf(
      input.pages.map((blocks) => ({ blocks })),
      {
        title: `${input.label} ${input.organization.name}`,
        author: input.organization.name,
      },
    );
    const qrImages = await Promise.all(
      qrValues.map(async (value) => ({
        filename: `${cids.get(value)}.png`,
        content: await QRCode.toBuffer(value, {
          errorCorrectionLevel: 'Q',
          margin: 1,
          width: 280,
        }),
        contentType: 'image/png',
        cid: cids.get(value)!,
      })),
    );
    return this.emailService.sendEmail({
      to: input.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      fromName: input.organization.name,
      replyTo: this.replyTo(input.organization),
      redactRecipient: true,
      attachments: [
        {
          filename: input.filename,
          content: pdf,
          contentType: 'application/pdf',
        },
        ...qrImages,
      ],
    });
  }

  // ---------------------------------------------------------- Oeffentlich

  private linkGone() {
    return new NotFoundException({
      code: ErrorCodes.RECEIPT_LINK_NOT_FOUND,
      message:
        'Dieser Beleg ist nicht (mehr) verfügbar. Frag an der Kasse nach einem neuen.',
    });
  }

  /** Gueltiger Link zum Token, sonst 404 (abgelaufen, unbekannt). */
  async resolveLink(token: string): Promise<ReceiptLink> {
    if (!isReceiptToken(token)) throw this.linkGone();
    const link = await this.linkRepository.findOne({
      where: {
        tokenHash: receiptTokenHash(token),
        expiresAt: MoreThan(new Date()),
      },
    });
    if (!link) throw this.linkGone();
    return link;
  }

  private async linkDocuments(link: ReceiptLink) {
    try {
      return await this.documents(link.organizationId, link.orderIds);
    } catch (error) {
      // Bestellung geloescht (Testbestellungen), Betriebsart gewechselt …
      if (error instanceof HttpException) throw this.linkGone();
      throw error;
    }
  }

  async publicView(token: string): Promise<PublicReceiptView> {
    const link = await this.resolveLink(token);
    if (link.kind === 'hospitality' && link.hospitalityReceiptId) {
      return this.publicHospitalityView(link);
    }
    const { organization, timeZone, documents } =
      await this.linkDocuments(link);
    return {
      organizationName: organization.name,
      expiresAt: link.expiresAt.toISOString(),
      receipts: documents.map((doc) => ({
        kind: 'receipt' as const,
        orderNumber: doc.orderNumber,
        isTest: doc.isTest,
        blocks: receiptBlocks(doc, timeZone),
      })),
      legal: toPublicLegalInfo(organization, this.deployment.platformLegal),
    };
  }

  /** Bewirtungsbeleg aus dem gespeicherten Schnappschuss (unveraenderlich). */
  private async publicHospitalityView(
    link: ReceiptLink,
  ): Promise<PublicReceiptView> {
    const receipt = await this.hospitalityRepository.findOne({
      where: {
        id: link.hospitalityReceiptId!,
        organizationId: link.organizationId,
      },
    });
    if (!receipt) throw this.linkGone();
    const organization = await this.organization(link.organizationId);
    const timeZone = resolveOrderTimeZone(organization.settings?.timezone);
    return {
      organizationName: organization.name,
      expiresAt: link.expiresAt.toISOString(),
      receipts: [
        {
          kind: 'hospitality',
          orderNumber: receipt.number ?? 'TEST',
          isTest: receipt.isTest,
          blocks: hospitalityBlocks(
            {
              number: receipt.number,
              issuedAt: receipt.issuedAt,
              serviceDate: receipt.serviceDate,
              recipientName: receipt.recipientName,
              recipientAddress: receipt.recipientAddress,
              snapshot: receipt.snapshot as unknown as HospitalitySnapshot,
            },
            { copy: link.copy, timeZone },
          ),
        },
      ],
      legal: toPublicLegalInfo(organization, this.deployment.platformLegal),
    };
  }

  async publicPdf(token: string): Promise<{ filename: string; pdf: Buffer }> {
    const view = await this.publicView(token);
    const hospitality = view.receipts[0]?.kind === 'hospitality';
    const label = hospitality ? 'Bewirtungsbeleg' : 'Kassenbeleg';
    const pdf = await renderReceiptPdf(
      view.receipts.map((r) => ({ blocks: r.blocks })),
      {
        title: `${label} ${view.organizationName}`,
        author: view.organizationName,
      },
    );
    const number = view.receipts[0]?.orderNumber ?? 'Beleg';
    const prefix = hospitality ? 'Bewirtungsbeleg' : 'Beleg';
    return {
      filename: `${prefix}-${number.replace(/[^A-Za-z0-9-]/g, '')}.pdf`,
      pdf,
    };
  }

  /** Abgelaufene Links loeschen (Loeschlauf `receipt_links`). */
  async purgeExpired(now = new Date()): Promise<number> {
    const result = await this.linkRepository.delete({
      expiresAt: Not(MoreThan(now)),
    });
    return result.affected ?? 0;
  }
}
