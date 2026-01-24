import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Printer, User, UserOrganization } from '../../database/entities';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { PaginationDto, PaginatedResult, createPaginatedResult } from '../../common/dto/pagination.dto';
import { CreatePrinterDto, UpdatePrinterDto } from './dto';

@Injectable()
export class PrintersService {
  private readonly logger = new Logger(PrintersService.name);

  constructor(
    @InjectRepository(Printer)
    private readonly printerRepository: Repository<Printer>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
  ) {}

  async create(
    organizationId: string,
    createDto: CreatePrinterDto,
    user: User,
  ): Promise<Printer> {
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

    const printer = this.printerRepository.create({
      organizationId,
      name: createDto.name,
      type: createDto.type,
      connectionType: createDto.connectionType,
      connectionConfig: createDto.connectionConfig || {},
      agentId: createDto.agentId || null,
      isActive: true,
      isOnline: false,
    });

    await this.printerRepository.save(printer);
    this.logger.log(`Printer created: ${printer.name} (${printer.id})`);

    return printer;
  }

  async findAll(
    organizationId: string,
    user: User,
    pagination: PaginationDto,
  ): Promise<PaginatedResult<Printer>> {
    await this.checkMembership(organizationId, user.id);

    const { page = 1, limit = 50 } = pagination;
    const skip = (page - 1) * limit;

    const [items, total] = await this.printerRepository.findAndCount({
      where: { organizationId },
      skip,
      take: limit,
      order: { name: 'ASC' },
    });

    return createPaginatedResult(items, total, page, limit);
  }

  async findOne(organizationId: string, printerId: string, user: User): Promise<Printer> {
    await this.checkMembership(organizationId, user.id);

    const printer = await this.printerRepository.findOne({
      where: { id: printerId, organizationId },
    });

    if (!printer) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Drucker nicht gefunden',
      });
    }

    return printer;
  }

  async update(
    organizationId: string,
    printerId: string,
    updateDto: UpdatePrinterDto,
    user: User,
  ): Promise<Printer> {
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

    const printer = await this.findOne(organizationId, printerId, user);
    Object.assign(printer, updateDto);
    await this.printerRepository.save(printer);

    this.logger.log(`Printer updated: ${printer.name} (${printer.id})`);

    return printer;
  }

  async remove(organizationId: string, printerId: string, user: User): Promise<void> {
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

    const printer = await this.findOne(organizationId, printerId, user);
    await this.printerRepository.remove(printer);

    this.logger.log(`Printer deleted: ${printer.name} (${printer.id})`);
  }

  async updateOnlineStatus(printerId: string, isOnline: boolean): Promise<void> {
    await this.printerRepository.update(
      { id: printerId },
      { isOnline, lastSeenAt: isOnline ? new Date() : undefined },
    );
  }

  async testPrint(
    organizationId: string,
    printerId: string,
    user: User,
  ): Promise<{ success: boolean; message: string }> {
    await this.checkRole(organizationId, user.id, OrganizationRole.MANAGER);

    const printer = await this.findOne(organizationId, printerId, user);

    if (!printer.isActive) {
      return { success: false, message: 'Drucker ist deaktiviert' };
    }

    if (!printer.isOnline) {
      return { success: false, message: 'Drucker ist offline' };
    }

    // In production, this would send a test print job to the printer agent
    // For now, we just simulate success
    this.logger.log(`Test print requested for printer: ${printer.name}`);

    return { success: true, message: 'Testdruck wurde gesendet' };
  }

  private async checkMembership(organizationId: string, userId: string): Promise<void> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }
  }

  private async checkRole(
    organizationId: string,
    userId: string,
    requiredRole: OrganizationRole,
  ): Promise<void> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }

    const roleHierarchy: Record<OrganizationRole, number> = {
      [OrganizationRole.ADMIN]: 100,
      [OrganizationRole.MANAGER]: 80,
      [OrganizationRole.CASHIER]: 40,
      [OrganizationRole.KITCHEN]: 20,
      [OrganizationRole.DELIVERY]: 20,
    };

    if (roleHierarchy[membership.role] < roleHierarchy[requiredRole]) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }
  }
}
