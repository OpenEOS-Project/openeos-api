import { pfandLegacyBalance } from './pfand-legacy-balance';
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  DEFAULT_PFAND_VAT_RATE,
  PfandType,
} from '../../database/entities/pfand-type.entity';
import { User } from '../../database/entities/user.entity';
import {
  UserOrganization,
  OrganizationRole,
} from '../../database/entities/user-organization.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { CreatePfandTypeDto, UpdatePfandTypeDto } from './dto';

@Injectable()
export class PfandTypesService {
  private readonly logger = new Logger(PfandTypesService.name);

  constructor(
    @InjectRepository(PfandType)
    private readonly pfandTypeRepository: Repository<PfandType>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
  ) {}

  async create(
    organizationId: string,
    createDto: CreatePfandTypeDto,
    user: User,
  ): Promise<PfandType> {
    await this.checkPermission(organizationId, user.id);

    const pfandType = this.pfandTypeRepository.create({
      organizationId,
      name: createDto.name,
      amount: createDto.amount,
      vatRate: createDto.vatRate ?? DEFAULT_PFAND_VAT_RATE,
      isActive: createDto.isActive ?? true,
      sortOrder: createDto.sortOrder ?? 0,
    });

    await this.pfandTypeRepository.save(pfandType);
    this.logger.log(`Pfand type created: ${pfandType.name} (${pfandType.id})`);

    return pfandType;
  }

  async findAll(organizationId: string, user: User): Promise<PfandType[]> {
    await this.checkMembership(organizationId, user.id);

    return this.pfandTypeRepository.find({
      where: { organizationId },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }

  /**
   * Pfand-Altsaldo der Organisation (siehe pfand-legacy-balance.ts) fuer
   * den Hinweis in den Pfand-Einstellungen und im Bericht.
   */
  async legacyBalance(
    organizationId: string,
    user: User,
  ): Promise<{
    applies: boolean;
    charged: number;
    returned: number;
    remaining: number;
  }> {
    await this.checkMembership(organizationId, user.id);
    const rows: { settings: { vatExempt?: boolean } | null }[] =
      await this.pfandTypeRepository.manager.query(
        `SELECT settings FROM organizations WHERE id = $1`,
        [organizationId],
      );
    const balance = await pfandLegacyBalance(
      this.pfandTypeRepository.manager,
      organizationId,
    );
    return {
      applies: rows[0]?.settings?.vatExempt === false,
      charged: balance.chargedCents / 100,
      returned: Math.min(balance.returnedCents, balance.chargedCents) / 100,
      remaining: balance.remainingCents / 100,
    };
  }

  /** Active pfand types for the POS (device-authenticated, no user permission check). */
  async findActiveForOrg(organizationId: string): Promise<PfandType[]> {
    return this.pfandTypeRepository.find({
      where: { organizationId, isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }

  async findOne(
    organizationId: string,
    pfandTypeId: string,
    user: User,
  ): Promise<PfandType> {
    await this.checkMembership(organizationId, user.id);

    const pfandType = await this.pfandTypeRepository.findOne({
      where: { id: pfandTypeId, organizationId },
    });

    if (!pfandType) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.DEPOSIT_TYPE_NOT_FOUND,
        message: 'Pfand-Typ nicht gefunden',
      });
    }

    return pfandType;
  }

  async update(
    organizationId: string,
    pfandTypeId: string,
    updateDto: UpdatePfandTypeDto,
    user: User,
  ): Promise<PfandType> {
    await this.checkPermission(organizationId, user.id);

    const pfandType = await this.findOne(organizationId, pfandTypeId, user);

    if (updateDto.name !== undefined) pfandType.name = updateDto.name;
    if (updateDto.amount !== undefined) pfandType.amount = updateDto.amount;
    // Gilt nur fuer neue Buchungen: Positionen und Auszahlungen halten
    // ihren Satz als Snapshot fest.
    if (updateDto.vatRate !== undefined) pfandType.vatRate = updateDto.vatRate;
    if (updateDto.isActive !== undefined)
      pfandType.isActive = updateDto.isActive;
    if (updateDto.sortOrder !== undefined)
      pfandType.sortOrder = updateDto.sortOrder;

    await this.pfandTypeRepository.save(pfandType);
    this.logger.log(`Pfand type updated: ${pfandType.name} (${pfandType.id})`);

    return pfandType;
  }

  async remove(
    organizationId: string,
    pfandTypeId: string,
    user: User,
  ): Promise<void> {
    await this.checkPermission(organizationId, user.id);

    const pfandType = await this.findOne(organizationId, pfandTypeId, user);
    await this.pfandTypeRepository.remove(pfandType);

    this.logger.log(`Pfand type deleted: ${pfandType.name} (${pfandTypeId})`);
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
        reason: ErrorReasons.ORGANIZATION_ACCESS_DENIED,
        message: 'Kein Zugriff auf diese Organisation',
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
      !membership.permissions?.pfand
    ) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }
  }
}
