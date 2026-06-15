import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  DiscountVoucher,
  DiscountVoucherType,
} from '../../database/entities/discount-voucher.entity';
import { User } from '../../database/entities/user.entity';
import {
  UserOrganization,
  OrganizationRole,
} from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { CreateDiscountVoucherDto, UpdateDiscountVoucherDto } from './dto';

@Injectable()
export class DiscountVouchersService {
  private readonly logger = new Logger(DiscountVouchersService.name);

  constructor(
    @InjectRepository(DiscountVoucher)
    private readonly discountVoucherRepository: Repository<DiscountVoucher>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
  ) {}

  async create(
    organizationId: string,
    createDto: CreateDiscountVoucherDto,
    user: User,
  ): Promise<DiscountVoucher> {
    await this.checkPermission(organizationId, user.id);

    const voucher = this.discountVoucherRepository.create({
      organizationId,
      name: createDto.name,
      description: createDto.description ?? null,
      type: createDto.type,
      amount: this.normalizeAmount(createDto.type, createDto.amount),
      isActive: createDto.isActive ?? true,
      allowMultiplePerOrder: createDto.allowMultiplePerOrder ?? false,
      sortOrder: createDto.sortOrder ?? 0,
    });

    await this.discountVoucherRepository.save(voucher);
    this.logger.log(
      `Discount voucher created: ${voucher.name} (${voucher.id})`,
    );

    return voucher;
  }

  async findAll(
    organizationId: string,
    user: User,
  ): Promise<DiscountVoucher[]> {
    await this.checkMembership(organizationId, user.id);

    return this.discountVoucherRepository.find({
      where: { organizationId },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }

  /** Active vouchers for the POS (device-authenticated, no user permission check). */
  async findActiveForOrg(organizationId: string): Promise<DiscountVoucher[]> {
    return this.discountVoucherRepository.find({
      where: { organizationId, isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }

  async findOne(
    organizationId: string,
    voucherId: string,
    user: User,
  ): Promise<DiscountVoucher> {
    await this.checkMembership(organizationId, user.id);

    const voucher = await this.discountVoucherRepository.findOne({
      where: { id: voucherId, organizationId },
    });

    if (!voucher) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Rabatt-Bon nicht gefunden',
      });
    }

    return voucher;
  }

  async update(
    organizationId: string,
    voucherId: string,
    updateDto: UpdateDiscountVoucherDto,
    user: User,
  ): Promise<DiscountVoucher> {
    await this.checkPermission(organizationId, user.id);

    const voucher = await this.findOne(organizationId, voucherId, user);

    if (updateDto.name !== undefined) voucher.name = updateDto.name;
    if (updateDto.description !== undefined)
      voucher.description = updateDto.description ?? null;
    if (updateDto.isActive !== undefined) voucher.isActive = updateDto.isActive;
    if (updateDto.allowMultiplePerOrder !== undefined)
      voucher.allowMultiplePerOrder = updateDto.allowMultiplePerOrder;
    if (updateDto.sortOrder !== undefined)
      voucher.sortOrder = updateDto.sortOrder;

    // Type and amount are coupled: recompute amount whenever either changes.
    const nextType = updateDto.type ?? voucher.type;
    if (updateDto.type !== undefined || updateDto.amount !== undefined) {
      const nextAmount =
        updateDto.amount !== undefined
          ? updateDto.amount
          : (voucher.amount ?? undefined);
      voucher.amount = this.normalizeAmount(nextType, nextAmount);
    }
    voucher.type = nextType;

    await this.discountVoucherRepository.save(voucher);
    this.logger.log(
      `Discount voucher updated: ${voucher.name} (${voucher.id})`,
    );

    return voucher;
  }

  async remove(
    organizationId: string,
    voucherId: string,
    user: User,
  ): Promise<void> {
    await this.checkPermission(organizationId, user.id);

    const voucher = await this.findOne(organizationId, voucherId, user);
    await this.discountVoucherRepository.remove(voucher);

    this.logger.log(`Discount voucher deleted: ${voucher.name} (${voucherId})`);
  }

  /** A FIXED voucher requires a non-negative amount; a MANUAL voucher stores no amount. */
  private normalizeAmount(
    type: DiscountVoucherType,
    amount: number | null | undefined,
  ): number | null {
    if (type === DiscountVoucherType.MANUAL) {
      return null;
    }
    if (amount === null || amount === undefined) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Ein fester Rabatt-Bon benötigt einen Betrag',
      });
    }
    return amount;
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
      !membership.permissions?.discounts
    ) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }
  }
}
