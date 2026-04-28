import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Printer, Device, User, UserOrganization } from '../../database/entities';
import { DeviceType } from '../../database/entities/device.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { PaginationDto, PaginatedResult, createPaginatedResult } from '../../common/dto/pagination.dto';
import { CreatePrinterDto, UpdatePrinterDto } from './dto';
import { GatewayService } from '../gateway/gateway.service';

@Injectable()
export class PrintersService {
  private readonly logger = new Logger(PrintersService.name);

  constructor(
    @InjectRepository(Printer)
    private readonly printerRepository: Repository<Printer>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
  ) {}

  async create(
    organizationId: string,
    createDto: CreatePrinterDto,
    user: User,
  ): Promise<Printer> {
    await this.checkPermission(organizationId, user.id, 'devices');

    // Validate deviceId if provided
    if (createDto.deviceId) {
      await this.validateDeviceForOrg(createDto.deviceId, organizationId);
    }

    const printer = this.printerRepository.create({
      organizationId,
      name: createDto.name,
      type: createDto.type,
      connectionType: createDto.connectionType,
      connectionConfig: createDto.connectionConfig || {},
      deviceId: createDto.deviceId || null,
      paperWidth: createDto.paperWidth || 80,
      isActive: true,
      isOnline: false,
    });

    await this.printerRepository.save(printer);
    this.logger.log(`Printer created: ${printer.name} (${printer.id})`);

    // Notify the device about config change
    if (printer.deviceId) {
      this.notifyDeviceConfigUpdate(organizationId, printer.deviceId);
    }

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
    await this.checkPermission(organizationId, user.id, 'devices');

    const printer = await this.findOne(organizationId, printerId, user);
    const previousDeviceId = printer.deviceId;

    // Validate new deviceId if provided
    if (updateDto.deviceId !== undefined && updateDto.deviceId !== previousDeviceId) {
      if (updateDto.deviceId) {
        await this.validateDeviceForOrg(updateDto.deviceId, organizationId);
      }
    }

    Object.assign(printer, updateDto);
    await this.printerRepository.save(printer);

    this.logger.log(`Printer updated: ${printer.name} (${printer.id})`);

    // Notify affected devices about config change
    if (previousDeviceId && previousDeviceId !== printer.deviceId) {
      this.notifyDeviceConfigUpdate(organizationId, previousDeviceId);
    }
    if (printer.deviceId) {
      this.notifyDeviceConfigUpdate(organizationId, printer.deviceId);
    }

    return printer;
  }

  async remove(organizationId: string, printerId: string, user: User): Promise<void> {
    await this.checkPermission(organizationId, user.id, 'devices');

    const printer = await this.findOne(organizationId, printerId, user);
    const deviceId = printer.deviceId;

    await this.printerRepository.remove(printer);

    this.logger.log(`Printer deleted: ${printer.name} (${printer.id})`);

    // Notify the device about config change
    if (deviceId) {
      this.notifyDeviceConfigUpdate(organizationId, deviceId);
    }
  }

  async findByDeviceId(deviceId: string): Promise<Printer[]> {
    return this.printerRepository.find({
      where: { deviceId, isActive: true },
      order: { name: 'ASC' },
    });
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
    await this.checkPermission(organizationId, user.id, 'devices');

    const printer = await this.findOne(organizationId, printerId, user);

    if (!printer.isActive) {
      return { success: false, message: 'Drucker ist deaktiviert' };
    }

    if (!printer.isOnline) {
      return { success: false, message: 'Drucker ist offline' };
    }

    this.logger.log(`Test print requested for printer: ${printer.name}`);

    return { success: true, message: 'Testdruck wurde gesendet' };
  }

  private async validateDeviceForOrg(deviceId: string, organizationId: string): Promise<void> {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId },
    });

    if (!device) {
      throw new BadRequestException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Gerät nicht gefunden',
      });
    }

    if (device.type !== DeviceType.PRINTER_AGENT) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Gerät ist kein Printer Agent',
      });
    }

    if (device.organizationId !== organizationId) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Gerät gehört nicht zu dieser Organisation',
      });
    }
  }

  private notifyDeviceConfigUpdate(organizationId: string, deviceId: string): void {
    try {
      this.gatewayService.notifyPrinterConfigUpdate(organizationId, deviceId);
    } catch (error) {
      this.logger.warn(`Failed to notify device ${deviceId} about config update: ${error}`);
    }
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

  private async checkPermission(
    organizationId: string,
    userId: string,
    permission: 'products' | 'events' | 'devices' | 'members' | 'shiftPlans',
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

    if (membership.role === OrganizationRole.ADMIN) {
      return;
    }

    if (!membership.permissions?.[permission]) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }
  }
}
