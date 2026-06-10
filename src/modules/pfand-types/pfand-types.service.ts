import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PfandType } from '../../database/entities/pfand-type.entity';
import { User } from '../../database/entities/user.entity';
import {
  UserOrganization,
  OrganizationRole,
} from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
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
        message: 'Keine ausreichenden Berechtigungen',
      });
    }
  }
}
