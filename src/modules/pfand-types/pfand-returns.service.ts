import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  Logger,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PfandType } from '../../database/entities/pfand-type.entity';
import { Event, EventStatus } from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import { EventPhaseService } from '../events/event-phase.service';
import {
  assertCashAllowed,
  OPERATING_MODE_SELECT,
} from '../../common/utils/operating-mode.util';
import { assertPaymentsAllowed } from '../../common/utils/operating-mode.util';
import {
  PfandReturn,
  PfandReturnLine,
} from '../../database/entities/pfand-return.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { GatewayService } from '../gateway/gateway.service';
import { TseSigningService } from '../tse/tse-signing.service';
import type { TseReceiptView } from '../tse/tse-view';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { pfandVatRate } from '../../common/utils/pfand-policy';
import { CreatePfandReturnDto } from './dto';
import {
  pfandReturnTaxLines,
  savePfandReturnWithNumber,
} from './pfand-return-receipt';

interface PfandReturnContext {
  eventId?: string | null;
  deviceId?: string | null;
  /** Name der Kasse fuer den Beleg. */
  deviceName?: string | null;
  userId?: string | null;
  /** Bediener fuer den Beleg, falls bekannt. */
  actorName?: string | null;
  cashDrawerPrinterId?: string | null;
}

/** Auszahlung mit TSE-Daten und ob der Beleg gedruckt wurde. */
export type PfandReturnResult = PfandReturn & {
  tse: TseReceiptView | null;
  /** Beleg automatisch gedruckt (Einstellung „Kassenbon“ nach Zahlung). */
  printed: boolean;
};

@Injectable()
export class PfandReturnsService {
  private readonly logger = new Logger(PfandReturnsService.name);

  constructor(
    @InjectRepository(PfandReturn)
    private readonly pfandReturnRepository: Repository<PfandReturn>,
    @InjectRepository(PfandType)
    private readonly pfandTypeRepository: Repository<PfandType>,
    private readonly gatewayService: GatewayService,
    @Optional()
    private readonly tseSigning?: TseSigningService,
    @Optional()
    private readonly eventPhaseService?: EventPhaseService,
    @Optional()
    @Inject(forwardRef(() => OrderPrintService))
    private readonly orderPrintService?: OrderPrintService,
  ) {}

  /**
   * Records a deposit payout. Resolves amounts server-side from the org's
   * PfandTypes, opens the cash drawer, and emits a real-time event.
   *
   * Die Auszahlung ist immer Bargeld — im bargeldlosen Modus deshalb
   * gesperrt. Zurueckgegebenes Pfand laesst sich dort nur gegen neues
   * Pfand im Warenkorb verrechnen (Kasse, ohne diesen Endpunkt) oder ueber
   * eine Erstattung auf die urspruengliche Zahlart zurueckgeben.
   */
  async create(
    organizationId: string,
    dto: CreatePfandReturnDto,
    context: PfandReturnContext = {},
  ): Promise<PfandReturnResult> {
    const organization = await this.pfandReturnRepository.manager.findOne(
      Organization,
      { where: { id: organizationId }, select: OPERATING_MODE_SELECT },
    );
    // „Nur Bons“: keine Auszahlung aus einer Kasse.
    assertPaymentsAllowed(organization);
    assertCashAllowed(organization);

    const typeIds = dto.lines.map((l) => l.pfandTypeId);
    const types = await this.pfandTypeRepository.find({
      where: { id: In(typeIds), organizationId },
    });
    const typeById = new Map(types.map((t) => [t.id, t]));

    const lines: PfandReturnLine[] = [];
    let totalAmount = 0;

    for (const line of dto.lines) {
      const type = typeById.get(line.pfandTypeId);
      if (!type) {
        throw new NotFoundException({
          code: ErrorCodes.NOT_FOUND,
          reason: ErrorReasons.DEPOSIT_TYPE_NOT_FOUND,
          message: `Pfand-Typ ${line.pfandTypeId} nicht gefunden`,
        });
      }
      const unitAmount = Number(type.amount);
      lines.push({
        pfandTypeId: type.id,
        name: type.name,
        unitAmount,
        quantity: line.quantity,
        // Rueckgabe mindert das Entgelt zum Satz der Pfandart (Snapshot).
        vatRate: pfandVatRate(type),
      });
      totalAmount += unitAmount * line.quantity;
    }

    if (totalAmount <= 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.DEPOSIT_RETURN_AMOUNT_INVALID,
        message: 'Rückgabebetrag muss größer als 0 sein',
      });
    }

    // Im Testmodus bzw. im Zustand „Geplant“ gebucht: wird beim Aktivieren
    // bzw. zu Beginn des Verkaufsfensters mit den Testbestellungen geloescht.
    const event = context.eventId
      ? await this.pfandReturnRepository.manager.findOne(Event, {
          where: { id: context.eventId },
        })
      : null;
    const phase =
      this.eventPhaseService ??
      EventPhaseService.standalone(
        this.pfandReturnRepository.manager?.getRepository?.(Organization),
      );
    const isTest =
      event?.status === EventStatus.TEST || (await phase.isTestModeNow(event));

    totalAmount = Math.round(totalAmount * 100) / 100;
    const pfandReturn = this.pfandReturnRepository.create({
      organizationId,
      eventId: context.eventId ?? null,
      isTest,
      deviceId: context.deviceId ?? null,
      createdByUserId: context.userId ?? null,
      totalAmount,
      lines,
      // MwSt je Satz (negativ) fuer Beleg und Nachdruck festhalten; leer bei
      // steuerbefreiten Organisationen.
      taxLines: pfandReturnTaxLines(lines, organization?.settings?.vatExempt),
    });
    // Belegnummer `P-JJJJMMTT-NNNN` und Insert in einer Transaktion.
    await savePfandReturnWithNumber(
      this.pfandReturnRepository.manager,
      pfandReturn,
    );

    this.logger.log(
      `Pfand return recorded: ${pfandReturn.id} (${totalAmount.toFixed(2)} €)`,
    );

    // Open the cash drawer to hand out the deposit, if one is configured.
    // The ledger row is already saved — a drawer failure must not roll it
    // back, but it should be visible in the logs.
    if (context.cashDrawerPrinterId) {
      try {
        this.gatewayService.sendOpenCashDrawer(
          organizationId,
          context.cashDrawerPrinterId,
        );
      } catch (error) {
        this.logger.warn(
          `Cash drawer open failed for pfand return ${pfandReturn.id}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }

    this.gatewayService.notifyPfandReturned(
      organizationId,
      pfandReturn.eventId,
      {
        pfandReturnId: pfandReturn.id,
        totalAmount,
      },
    );

    // Cloud-TSE: Auszahlung als Kassenbeleg mit negativem Betrag (bar).
    const tse = (await this.tseSigning?.signPfandReturn(pfandReturn)) ?? null;

    // Beleg erst nach der Signatur (AEAO zu § 146a Nr. 2.5). Gedruckt wird
    // nach derselben Regel wie der Kassenbon beim Verkauf: automatisch, wenn
    // die Organisation Kassenbons nach der Zahlung druckt, sonst auf Wunsch
    // an der Kasse (POST /device-api/pfand-returns/:id/print).
    let printed = false;
    if (
      this.orderPrintService &&
      (await this.orderPrintService.autoPrintsReceipts(organizationId))
    ) {
      printed = await this.orderPrintService.printPfandReturnReceipt(
        organizationId,
        {
          pfandReturn,
          deviceName: context.deviceName ?? null,
          actorName: context.actorName ?? null,
          tse,
        },
      );
    }
    return Object.assign(pfandReturn, { tse, printed });
  }

  /**
   * Beleg einer Auszahlung (erneut) drucken — „Bon drucken“ an der Kasse
   * bzw. Nachdruck. Nimmt die gespeicherten Betraege, MwSt-Zeilen und
   * TSE-Daten; legt keine neue Transaktion an.
   */
  async printReceipt(
    organizationId: string,
    pfandReturnId: string,
    context: {
      deviceId?: string | null;
      deviceName?: string | null;
      reprint?: boolean;
    } = {},
  ): Promise<{ printed: boolean }> {
    const pfandReturn = await this.pfandReturnRepository.findOne({
      where: { id: pfandReturnId, organizationId },
    });
    if (!pfandReturn) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.DEPOSIT_RETURN_NOT_FOUND,
        message: 'Pfand-Rückgabe nicht gefunden',
      });
    }
    if (!this.orderPrintService) return { printed: false };
    // Auf dem Drucker der Kasse, die druckt (sonst der der Auszahlung).
    const target = {
      ...pfandReturn,
      deviceId: context.deviceId ?? pfandReturn.deviceId,
    } as PfandReturn;
    const printed = await this.orderPrintService.printPfandReturnReceipt(
      organizationId,
      {
        pfandReturn: target,
        deviceName: context.deviceName ?? null,
        reprint: context.reprint === true,
        tse: (await this.tseSigning?.forPfandReturn(pfandReturn.id)) ?? null,
      },
    );
    return { printed };
  }
}
