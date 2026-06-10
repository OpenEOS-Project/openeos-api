import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PfandType } from '../../database/entities/pfand-type.entity';
import {
  PfandReturn,
  PfandReturnLine,
} from '../../database/entities/pfand-return.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { GatewayService } from '../gateway/gateway.service';
import { CreatePfandReturnDto } from './dto';

interface PfandReturnContext {
  eventId?: string | null;
  deviceId?: string | null;
  userId?: string | null;
  cashDrawerPrinterId?: string | null;
}

@Injectable()
export class PfandReturnsService {
  private readonly logger = new Logger(PfandReturnsService.name);

  constructor(
    @InjectRepository(PfandReturn)
    private readonly pfandReturnRepository: Repository<PfandReturn>,
    @InjectRepository(PfandType)
    private readonly pfandTypeRepository: Repository<PfandType>,
    private readonly gatewayService: GatewayService,
  ) {}

  /**
   * Records a deposit payout. Resolves amounts server-side from the org's
   * PfandTypes, opens the cash drawer, and emits a real-time event.
   */
  async create(
    organizationId: string,
    dto: CreatePfandReturnDto,
    context: PfandReturnContext = {},
  ): Promise<PfandReturn> {
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
          message: `Pfand-Typ ${line.pfandTypeId} nicht gefunden`,
        });
      }
      const unitAmount = Number(type.amount);
      lines.push({
        pfandTypeId: type.id,
        name: type.name,
        unitAmount,
        quantity: line.quantity,
      });
      totalAmount += unitAmount * line.quantity;
    }

    if (totalAmount <= 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Rückgabebetrag muss größer als 0 sein',
      });
    }

    const pfandReturn = this.pfandReturnRepository.create({
      organizationId,
      eventId: context.eventId ?? null,
      deviceId: context.deviceId ?? null,
      createdByUserId: context.userId ?? null,
      totalAmount,
      lines,
    });
    await this.pfandReturnRepository.save(pfandReturn);

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

    return pfandReturn;
  }
}
