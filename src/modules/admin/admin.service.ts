import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, MoreThanOrEqual } from 'typeorm';
import {
  Organization,
  User,
  SubscriptionConfig,
  Invoice,
  RentalHardware,
  RentalAssignment,
  AdminAuditLog,
  Event,
  Order,
  Printer,
  Device,
} from '../../database/entities';
import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import { InvoiceStatus } from '../../database/entities/invoice.entity';
import { RentalHardwareStatus, RentalHardwareType } from '../../database/entities/rental-hardware.entity';
import { DeviceType, DeviceStatus } from '../../database/entities/device.entity';
import { RentalAssignmentStatus } from '../../database/entities/rental-assignment.entity';
import {
  PrinterType,
  PrinterConnectionType,
  PrinterConnectionConfig,
} from '../../database/entities/printer.entity';

export interface PrinterPreviousConfig {
  printerId: string;
  name: string;
  type: PrinterType;
  connectionType: PrinterConnectionType;
  connectionConfig: PrinterConnectionConfig;
  paperWidth: number;
  hasCashDrawer: boolean;
}

export interface UnassignedPrinterDeviceListItem {
  id: string;
  name: string;
  suggestedName: string | null;
  type: DeviceType;
  status: DeviceStatus;
  lastSeenAt: Date | null;
  createdAt: Date;
  previousConfig: PrinterPreviousConfig | null;
}
import { EventStatus } from '../../database/entities/event.entity';
import { GatewayService } from '../gateway/gateway.service';
import { ErrorCodes } from '../../common/constants/error-codes';
import {
  QueryOrganizationsDto,
  QueryUsersDto,
  QueryInvoicesAdminDto,
  QueryAuditLogsDto,
  QueryRentalHardwareDto,
  QueryRentalAssignmentsAdminDto,
  SetDiscountDto,
  AccessOrganizationDto,
  CreateRentalHardwareDto,
  UpdateRentalHardwareDto,
  CreateRentalAssignmentDto,
  UpdateRentalAssignmentDto,
  UpdateOrganizationAdminDto,
  CreateSubscriptionConfigDto,
  UpdateSubscriptionConfigDto,
} from './dto';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(SubscriptionConfig)
    private readonly subscriptionConfigRepository: Repository<SubscriptionConfig>,
    @InjectRepository(Invoice)
    private readonly invoiceRepository: Repository<Invoice>,
    @InjectRepository(RentalHardware)
    private readonly rentalHardwareRepository: Repository<RentalHardware>,
    @InjectRepository(RentalAssignment)
    private readonly rentalAssignmentRepository: Repository<RentalAssignment>,
    @InjectRepository(AdminAuditLog)
    private readonly auditLogRepository: Repository<AdminAuditLog>,
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(Printer)
    private readonly printerRepository: Repository<Printer>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
  ) {}

  // === Organizations ===

  async findAllOrganizations(
    queryDto: QueryOrganizationsDto,
  ): Promise<{ data: Organization[]; total: number; page: number; limit: number }> {
    const { search, page = 1, limit = 20 } = queryDto;

    const queryBuilder = this.organizationRepository.createQueryBuilder('org');

    if (search) {
      queryBuilder.where(
        '(org.name ILIKE :search OR org.slug ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    const total = await queryBuilder.getCount();

    const data = await queryBuilder
      .orderBy('org.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return { data, total, page, limit };
  }

  async getOrganization(orgId: string): Promise<Organization> {
    const org = await this.organizationRepository.findOne({
      where: { id: orgId },
    });

    if (!org) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }

    return org;
  }

  async updateOrganization(
    orgId: string,
    updateDto: UpdateOrganizationAdminDto,
    adminUserId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<Organization> {
    const org = await this.getOrganization(orgId);
    const before = { ...org };

    Object.assign(org, updateDto);
    await this.organizationRepository.save(org);

    await this.createAuditLog(
      adminUserId,
      orgId,
      AdminAction.EDIT_ORGANIZATION,
      'organization',
      orgId,
      { before, after: org },
      ipAddress,
      userAgent,
    );

    return org;
  }

  async setDiscount(
    orgId: string,
    discountDto: SetDiscountDto,
    adminUserId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<Organization> {
    const org = await this.getOrganization(orgId);
    const before = { discountPercent: org.discountPercent, discountValidUntil: org.discountValidUntil };

    org.discountPercent = discountDto.discountPercent;
    org.discountValidUntil = discountDto.validUntil ? new Date(discountDto.validUntil) : null;
    await this.organizationRepository.save(org);

    await this.createAuditLog(
      adminUserId,
      orgId,
      AdminAction.SET_DISCOUNT,
      'organization',
      orgId,
      { before, after: { discountPercent: org.discountPercent, discountValidUntil: org.discountValidUntil }, reason: discountDto.reason },
      ipAddress,
      userAgent,
    );

    return org;
  }

  async removeDiscount(
    orgId: string,
    adminUserId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<Organization> {
    const org = await this.getOrganization(orgId);
    const before = { discountPercent: org.discountPercent, discountValidUntil: org.discountValidUntil };

    org.discountPercent = 0;
    org.discountValidUntil = null;
    await this.organizationRepository.save(org);

    await this.createAuditLog(
      adminUserId,
      orgId,
      AdminAction.REMOVE_DISCOUNT,
      'organization',
      orgId,
      { before, after: { discountPercent: 0, discountValidUntil: null } },
      ipAddress,
      userAgent,
    );

    return org;
  }

  async accessOrganizationWithPin(
    orgId: string,
    accessDto: AccessOrganizationDto,
    adminUserId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<boolean> {
    const org = await this.getOrganization(orgId);

    if (org.supportPin !== accessDto.supportPin) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Ungültiger Support-PIN',
      });
    }

    await this.createAuditLog(
      adminUserId,
      orgId,
      AdminAction.VIEW_ORGANIZATION,
      'organization',
      orgId,
      { accessMethod: 'support_pin' },
      ipAddress,
      userAgent,
    );

    return true;
  }

  async impersonateOrganization(
    orgId: string,
    adminUserId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<string> {
    await this.getOrganization(orgId);

    await this.createAuditLog(
      adminUserId,
      orgId,
      AdminAction.IMPERSONATE_START,
      'organization',
      orgId,
      {},
      ipAddress,
      userAgent,
    );

    // In production, this would generate a special token
    // For now, return a placeholder
    return `impersonate_${orgId}_${adminUserId}`;
  }

  // === Users ===

  async findAllUsers(
    queryDto: QueryUsersDto,
  ): Promise<{ data: User[]; total: number; page: number; limit: number }> {
    const { search, isLocked, page = 1, limit = 20 } = queryDto;

    const queryBuilder = this.userRepository.createQueryBuilder('user')
      .leftJoinAndSelect('user.userOrganizations', 'uo')
      .leftJoinAndSelect('uo.organization', 'org');

    if (search) {
      queryBuilder.where(
        '(user.email ILIKE :search OR user.firstName ILIKE :search OR user.lastName ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    if (isLocked !== undefined) {
      queryBuilder.andWhere('user.isLocked = :isLocked', { isLocked });
    }

    const total = await queryBuilder.getCount();

    const data = await queryBuilder
      .orderBy('user.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    // Remove sensitive fields
    data.forEach((u) => {
      delete (u as Partial<User>).passwordHash;
    });

    return { data, total, page, limit };
  }

  async getUser(userId: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['userOrganizations', 'userOrganizations.organization'],
    });

    if (!user) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Benutzer nicht gefunden' });
    }

    delete (user as Partial<User>).passwordHash;
    return user;
  }

  async unlockUser(
    userId: string,
    adminUserId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Benutzer nicht gefunden',
      });
    }

    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    await this.userRepository.save(user);

    await this.createAuditLog(
      adminUserId,
      null,
      AdminAction.UNLOCK_USER,
      'user',
      userId,
      { email: user.email },
      ipAddress,
      userAgent,
    );

    this.logger.log(`User unlocked: ${user.email}`);

    return user;
  }

  // === Invoices ===

  async findAllInvoices(
    queryDto: QueryInvoicesAdminDto,
  ): Promise<{ data: Invoice[]; total: number; page: number; limit: number }> {
    const { organizationId, status, startDate, endDate, page = 1, limit = 20 } = queryDto;

    const queryBuilder = this.invoiceRepository
      .createQueryBuilder('invoice')
      .leftJoinAndSelect('invoice.organization', 'org');

    if (organizationId) {
      queryBuilder.andWhere('invoice.organizationId = :organizationId', { organizationId });
    }

    if (status) {
      queryBuilder.andWhere('invoice.status = :status', { status });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('invoice.createdAt BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      });
    }

    const total = await queryBuilder.getCount();

    const data = await queryBuilder
      .orderBy('invoice.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return { data, total, page, limit };
  }

  async markInvoicePaid(
    invoiceId: string,
    adminUserId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<Invoice> {
    const invoice = await this.invoiceRepository.findOne({
      where: { id: invoiceId },
    });

    if (!invoice) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Rechnung nicht gefunden',
      });
    }

    invoice.status = InvoiceStatus.PAID;
    invoice.paidAt = new Date();
    await this.invoiceRepository.save(invoice);

    await this.createAuditLog(
      adminUserId,
      invoice.organizationId,
      AdminAction.MARK_INVOICE_PAID,
      'invoice',
      invoiceId,
      { invoiceNumber: invoice.invoiceNumber, total: invoice.total },
      ipAddress,
      userAgent,
    );

    this.logger.log(`Invoice marked as paid: ${invoice.invoiceNumber}`);

    return invoice;
  }

  // === Devices (Admin) ===

  async deleteDevice(deviceId: string): Promise<void> {
    const device = await this.deviceRepository.findOne({ where: { id: deviceId } });
    if (!device) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Gerät nicht gefunden' });
    }
    // Drop linked printer rows along with the device — they're useless without
    // an agent and would otherwise show up as orphans in the admin UI.
    await this.printerRepository.delete({ deviceId });
    await this.deviceRepository.delete({ id: deviceId });
    this.logger.log(`Admin deleted device ${deviceId}`);
  }

  async findAllDevices(params?: { type?: string; unassigned?: boolean }): Promise<Device[]> {
    const qb = this.deviceRepository.createQueryBuilder('device');

    if (params?.type) {
      qb.andWhere('device.type = :type', { type: params.type });
    }

    if (params?.unassigned) {
      qb.andWhere('device.organizationId IS NULL');
    }

    qb.orderBy('device.name', 'ASC');

    return qb.getMany();
  }

  // === Rental Hardware ===

  async findAllRentalHardware(
    queryDto: QueryRentalHardwareDto,
  ): Promise<{ data: RentalHardware[]; total: number; page: number; limit: number }> {
    const { type, status, search, page = 1, limit = 20 } = queryDto;

    const queryBuilder = this.rentalHardwareRepository.createQueryBuilder('hw');

    if (type) {
      queryBuilder.andWhere('hw.type = :type', { type });
    }

    if (status) {
      queryBuilder.andWhere('hw.status = :status', { status });
    }

    if (search) {
      queryBuilder.andWhere(
        '(hw.name ILIKE :search OR hw.serialNumber ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    const total = await queryBuilder.getCount();

    const data = await queryBuilder
      .leftJoinAndSelect('hw.device', 'device')
      .orderBy('hw.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return { data, total, page, limit };
  }

  async createRentalHardware(
    createDto: CreateRentalHardwareDto,
    adminUserId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<RentalHardware> {
    const hardware = this.rentalHardwareRepository.create({
      ...createDto,
      status: RentalHardwareStatus.AVAILABLE,
    });

    await this.rentalHardwareRepository.save(hardware);

    await this.createAuditLog(
      adminUserId,
      null,
      AdminAction.CREATE_RENTAL_HARDWARE,
      'rental_hardware',
      hardware.id,
      { name: hardware.name, serialNumber: hardware.serialNumber },
      ipAddress,
      userAgent,
    );

    this.logger.log(`Rental hardware created: ${hardware.name} (${hardware.serialNumber})`);

    return hardware;
  }

  async updateRentalHardware(
    hardwareId: string,
    updateDto: UpdateRentalHardwareDto,
  ): Promise<RentalHardware> {
    const hardware = await this.rentalHardwareRepository.findOne({
      where: { id: hardwareId },
    });

    if (!hardware) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Hardware nicht gefunden',
      });
    }

    Object.assign(hardware, updateDto);
    await this.rentalHardwareRepository.save(hardware);

    return hardware;
  }

  async deleteRentalHardware(hardwareId: string): Promise<void> {
    const hardware = await this.rentalHardwareRepository.findOne({
      where: { id: hardwareId },
    });

    if (!hardware) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Hardware nicht gefunden',
      });
    }

    // Check if hardware has active assignments
    const activeAssignment = await this.rentalAssignmentRepository.findOne({
      where: {
        rentalHardwareId: hardwareId,
        status: In([
          RentalAssignmentStatus.PENDING,
          RentalAssignmentStatus.CONFIRMED,
          RentalAssignmentStatus.ACTIVE,
        ]),
      },
    });

    if (activeAssignment) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Hardware hat aktive Zuweisungen und kann nicht gelöscht werden',
      });
    }

    await this.rentalHardwareRepository.remove(hardware);
  }

  // === Rental Assignments ===

  async findAllRentalAssignments(
    queryDto: QueryRentalAssignmentsAdminDto,
  ): Promise<{ data: RentalAssignment[]; total: number; page: number; limit: number }> {
    const { organizationId, hardwareId, status, startDate, endDate, page = 1, limit = 20 } = queryDto;

    const queryBuilder = this.rentalAssignmentRepository
      .createQueryBuilder('assignment')
      .leftJoinAndSelect('assignment.rentalHardware', 'hw')
      .leftJoinAndSelect('assignment.organization', 'org')
      .leftJoinAndSelect('assignment.event', 'event');

    if (organizationId) {
      queryBuilder.andWhere('assignment.organizationId = :organizationId', { organizationId });
    }

    if (hardwareId) {
      queryBuilder.andWhere('assignment.rentalHardwareId = :hardwareId', { hardwareId });
    }

    if (status) {
      queryBuilder.andWhere('assignment.status = :status', { status });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('assignment.startDate BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      });
    }

    const total = await queryBuilder.getCount();

    const data = await queryBuilder
      .orderBy('assignment.startDate', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return { data, total, page, limit };
  }

  async createRentalAssignment(
    createDto: CreateRentalAssignmentDto,
    adminUserId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<RentalAssignment> {
    const hardware = await this.rentalHardwareRepository.findOne({
      where: { id: createDto.rentalHardwareId },
    });

    if (!hardware) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Hardware nicht gefunden',
      });
    }

    if (hardware.status !== RentalHardwareStatus.AVAILABLE) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Hardware ist nicht verfügbar',
      });
    }

    const startDate = new Date(createDto.startDate);
    const endDate = new Date(createDto.endDate);
    const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    const totalAmount = totalDays * Number(hardware.dailyRate);

    const assignment = this.rentalAssignmentRepository.create({
      ...createDto,
      startDate,
      endDate,
      dailyRate: hardware.dailyRate,
      totalDays,
      totalAmount,
      status: RentalAssignmentStatus.PENDING,
      assignedByUserId: adminUserId,
    });

    await this.rentalAssignmentRepository.save(assignment);

    // Update hardware status
    hardware.status = RentalHardwareStatus.RENTED;
    await this.rentalHardwareRepository.save(hardware);

    await this.createAuditLog(
      adminUserId,
      createDto.organizationId,
      AdminAction.ASSIGN_RENTAL,
      'rental_assignment',
      assignment.id,
      { hardwareId: hardware.id, hardwareName: hardware.name },
      ipAddress,
      userAgent,
    );

    this.logger.log(`Rental assignment created: ${assignment.id}`);

    return this.rentalAssignmentRepository.findOne({
      where: { id: assignment.id },
      relations: ['rentalHardware', 'organization', 'event'],
    }) as Promise<RentalAssignment>;
  }

  async activateRental(
    assignmentId: string,
    adminUserId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<RentalAssignment> {
    const assignment = await this.rentalAssignmentRepository.findOne({
      where: { id: assignmentId },
      relations: ['rentalHardware', 'organization'],
    });

    if (!assignment) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Zuweisung nicht gefunden',
      });
    }

    if (assignment.status !== RentalAssignmentStatus.CONFIRMED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Zuweisung muss den Status "confirmed" haben',
      });
    }

    const hardware = assignment.rentalHardware;

    // If hardware is a printer with a linked device, reassign device to the org
    if (hardware.type === RentalHardwareType.PRINTER && hardware.deviceId) {
      const device = await this.deviceRepository.findOne({
        where: { id: hardware.deviceId },
      });

      if (device) {
        // Reassign device to the rental organization
        device.organizationId = assignment.organizationId;
        await this.deviceRepository.save(device);

        // Auto-create printer entry based on hardware config
        const config = hardware.hardwareConfig;
        const printer = this.printerRepository.create({
          organizationId: assignment.organizationId,
          name: hardware.name,
          type: (config.printerType as PrinterType) || PrinterType.RECEIPT,
          connectionType: (config.connectionType as PrinterConnectionType) || PrinterConnectionType.USB,
          connectionConfig: {
            ipAddress: config.ipAddress,
            port: config.port,
            usbVendorId: config.usbVendorId as string | undefined,
            usbProductId: config.usbProductId as string | undefined,
          },
          paperWidth: config.paperWidth || 80,
          deviceId: hardware.deviceId,
          rentalAssignmentId: assignment.id,
          isActive: true,
          isOnline: false,
        });

        await this.printerRepository.save(printer);
        this.logger.log(`Auto-created printer ${printer.name} (${printer.id}) for rental activation`);

        // Push config update to device via WebSocket
        try {
          this.gatewayService.notifyPrinterConfigUpdate(assignment.organizationId, hardware.deviceId);
        } catch (error) {
          this.logger.warn(`Failed to push config update to device ${hardware.deviceId}: ${error}`);
        }
      }
    }

    assignment.status = RentalAssignmentStatus.ACTIVE;
    await this.rentalAssignmentRepository.save(assignment);

    await this.createAuditLog(
      adminUserId,
      assignment.organizationId,
      AdminAction.ASSIGN_RENTAL,
      'rental_assignment',
      assignmentId,
      { hardwareId: hardware.id, action: 'activate' },
      ipAddress,
      userAgent,
    );

    this.logger.log(`Rental activated: ${assignmentId}`);

    return assignment;
  }

  async returnRental(
    assignmentId: string,
    adminUserId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<RentalAssignment> {
    const assignment = await this.rentalAssignmentRepository.findOne({
      where: { id: assignmentId },
      relations: ['rentalHardware'],
    });

    if (!assignment) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Zuweisung nicht gefunden',
      });
    }

    const hardware = assignment.rentalHardware;

    // Delete auto-created printers for this rental assignment
    const rentalPrinters = await this.printerRepository.find({
      where: { rentalAssignmentId: assignmentId },
    });

    if (rentalPrinters.length > 0) {
      const deviceIds = [...new Set(rentalPrinters.map((p) => p.deviceId).filter(Boolean))] as string[];
      await this.printerRepository.remove(rentalPrinters);
      this.logger.log(`Removed ${rentalPrinters.length} rental printers for assignment ${assignmentId}`);

      // Notify affected devices about config change
      for (const deviceId of deviceIds) {
        try {
          if (assignment.organizationId) {
            this.gatewayService.notifyPrinterConfigUpdate(assignment.organizationId, deviceId);
          }
        } catch (error) {
          this.logger.warn(`Failed to notify device ${deviceId}: ${error}`);
        }
      }
    }

    // Unassign device from organization if it was a printer rental with linked device
    if (hardware.type === RentalHardwareType.PRINTER && hardware.deviceId) {
      await this.deviceRepository.update(
        { id: hardware.deviceId },
        { organizationId: null },
      );
    }

    assignment.status = RentalAssignmentStatus.RETURNED;
    assignment.returnedAt = new Date();
    await this.rentalAssignmentRepository.save(assignment);

    // Update hardware status
    await this.rentalHardwareRepository.update(
      { id: assignment.rentalHardwareId },
      { status: RentalHardwareStatus.AVAILABLE },
    );

    await this.createAuditLog(
      adminUserId,
      assignment.organizationId,
      AdminAction.RETURN_RENTAL,
      'rental_assignment',
      assignmentId,
      { hardwareId: assignment.rentalHardwareId },
      ipAddress,
      userAgent,
    );

    this.logger.log(`Rental returned: ${assignmentId}`);

    return assignment;
  }

  // === Printers (Admin) ===

  async findAllPrinters(params?: { organizationId?: string }): Promise<{
    assigned: Array<Printer & { organization: Organization | null }>;
    unassigned: UnassignedPrinterDeviceListItem[];
  }> {
    const qb = this.printerRepository
      .createQueryBuilder('printer')
      .leftJoinAndSelect('printer.organization', 'organization')
      .leftJoinAndSelect('printer.device', 'device')
      .orderBy('organization.name', 'ASC')
      .addOrderBy('printer.name', 'ASC');

    if (params?.organizationId) {
      qb.andWhere('printer.organizationId = :orgId', { orgId: params.organizationId });
    } else {
      qb.andWhere('printer.organizationId IS NOT NULL');
    }

    const assigned = await qb.getMany();

    const unassignedDevices = await this.deviceRepository
      .createQueryBuilder('device')
      .where('device.type = :type', { type: DeviceType.PRINTER_AGENT })
      .andWhere('device.organizationId IS NULL')
      .orderBy('device.name', 'ASC')
      .getMany();

    // Pick up Printer rows for each unassigned device so we can preserve the
    // previously configured name + USB IDs across re-assignments.
    const deviceIds = unassignedDevices.map((d) => d.id);
    const previousPrinters = deviceIds.length
      ? await this.printerRepository
          .createQueryBuilder('printer')
          .where('printer.organizationId IS NULL')
          .andWhere('printer.deviceId IN (:...deviceIds)', { deviceIds })
          .getMany()
      : [];
    const previousByDeviceId = new Map(previousPrinters.map((p) => [p.deviceId, p]));

    const unassigned: UnassignedPrinterDeviceListItem[] = unassignedDevices.map((d) => {
      const prev = d.id ? previousByDeviceId.get(d.id) : undefined;
      return {
        id: d.id,
        name: d.name,
        suggestedName: d.suggestedName ?? null,
        type: d.type,
        status: d.status,
        lastSeenAt: d.lastSeenAt,
        createdAt: d.createdAt,
        previousConfig: prev
          ? {
              printerId: prev.id,
              name: prev.name,
              type: prev.type,
              connectionType: prev.connectionType,
              connectionConfig: prev.connectionConfig,
              paperWidth: prev.paperWidth,
              hasCashDrawer: prev.hasCashDrawer,
            }
          : null,
      };
    });

    return {
      assigned: assigned as Array<Printer & { organization: Organization | null }>,
      unassigned,
    };
  }

  async assignPrinterDevice(
    payload: {
      deviceId: string;
      organizationId: string;
      name: string;
      type: PrinterType;
      connectionType: PrinterConnectionType;
      connectionConfig?: Record<string, unknown>;
      paperWidth?: number;
      hasCashDrawer?: boolean;
    },
    actor: User,
    ipAddress: string,
    userAgent?: string,
  ): Promise<Printer> {
    const device = await this.deviceRepository.findOne({ where: { id: payload.deviceId } });
    if (!device) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Gerät nicht gefunden' });
    }
    if (device.type !== DeviceType.PRINTER_AGENT) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Nur Drucker-Agents können als Drucker zugewiesen werden',
      });
    }
    if (device.organizationId) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Gerät ist bereits einer Organisation zugewiesen',
      });
    }
    const organization = await this.organizationRepository.findOne({ where: { id: payload.organizationId } });
    if (!organization) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Organisation nicht gefunden' });
    }

    // Re-use an existing Printer row for this device if it was previously assigned and
    // unassigned — that keeps name + USB IDs + paperWidth + cash-drawer setting.
    const existing = await this.printerRepository.findOne({ where: { deviceId: device.id } });
    let saved: Printer;
    if (existing) {
      existing.organizationId = payload.organizationId;
      existing.name = payload.name;
      existing.type = payload.type;
      existing.connectionType = payload.connectionType;
      // Don't clobber a previously detected connectionConfig with an empty object.
      if (payload.connectionConfig && Object.keys(payload.connectionConfig).length > 0) {
        existing.connectionConfig = payload.connectionConfig as Printer['connectionConfig'];
      }
      if (payload.paperWidth !== undefined) existing.paperWidth = payload.paperWidth;
      if (payload.hasCashDrawer !== undefined) existing.hasCashDrawer = payload.hasCashDrawer;
      existing.isActive = true;
      saved = await this.printerRepository.save(existing);
    } else {
      const printer = this.printerRepository.create({
        organizationId: payload.organizationId,
        name: payload.name,
        type: payload.type,
        connectionType: payload.connectionType,
        connectionConfig: (payload.connectionConfig ?? {}) as Printer['connectionConfig'],
        deviceId: device.id,
        paperWidth: payload.paperWidth ?? 80,
        hasCashDrawer: payload.hasCashDrawer ?? false,
        isActive: true,
      });
      saved = await this.printerRepository.save(printer);
    }

    device.organizationId = payload.organizationId;
    device.status = DeviceStatus.VERIFIED;
    device.verifiedAt = new Date();
    device.verifiedById = actor.id;
    await this.deviceRepository.save(device);

    // If the agent is already connected via WebSocket, move its socket to the
    // new organization room so the assignment takes effect without a restart.
    this.gatewayService.reassignDeviceRoom(device.id, payload.organizationId);

    await this.createAuditLog(
      actor.id,
      payload.organizationId,
      AdminAction.EDIT_ORGANIZATION,
      'printer',
      saved.id,
      {
        operation: 'assign_printer_device',
        deviceId: device.id,
        organizationId: payload.organizationId,
        organizationName: organization.name,
      },
      ipAddress,
      userAgent,
    );

    this.logger.log(`Admin ${actor.id} assigned device ${device.id} as printer ${saved.id} to org ${payload.organizationId}`);

    return saved;
  }

  async updatePrinterAdmin(
    printerId: string,
    update: { hasCashDrawer?: boolean },
  ): Promise<Printer> {
    const printer = await this.printerRepository.findOne({ where: { id: printerId } });
    if (!printer) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Drucker nicht gefunden' });
    }
    if (update.hasCashDrawer !== undefined) {
      printer.hasCashDrawer = update.hasCashDrawer;
    }
    return this.printerRepository.save(printer);
  }

  async unassignPrinter(
    printerId: string,
    actor: User,
    ipAddress: string,
    userAgent?: string,
  ): Promise<void> {
    const printer = await this.printerRepository.findOne({
      where: { id: printerId },
      relations: ['device', 'organization'],
    });
    if (!printer) {
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: 'Drucker nicht gefunden' });
    }

    const deviceId = printer.deviceId;
    const organizationId = printer.organizationId;

    // Keep the Printer row (with name, connection config, USB IDs, …) so the
    // operator can re-assign the same physical device later without losing
    // setup work. Only the org link gets cleared.
    // Note: using `update` instead of `save` so the loaded `organization` relation
    // doesn't override our null assignment when TypeORM resolves the FK.
    await this.printerRepository.update({ id: printer.id }, { organizationId: null });

    if (deviceId) {
      const device = await this.deviceRepository.findOne({ where: { id: deviceId } });
      if (device) {
        // Only drop the org link — keep status=verified so the agent stays
        // connected via WebSocket and can be reassigned without re-pairing.
        device.organizationId = null;
        await this.deviceRepository.save(device);
      }
      // Move the agent's socket out of the old org room so it doesn't keep
      // receiving jobs from that org while it's idle.
      this.gatewayService.reassignDeviceRoom(deviceId, null);
    }

    await this.createAuditLog(
      actor.id,
      organizationId,
      AdminAction.EDIT_ORGANIZATION,
      'printer',
      printerId,
      {
        operation: 'unassign_printer',
        deviceId,
        organizationId,
      },
      ipAddress,
      userAgent,
    );

    this.logger.log(`Admin ${actor.id} unassigned printer ${printerId}`);
  }

  // === Statistics ===

  async getOverviewStats(): Promise<{
    totalOrganizations: number;
    totalUsers: number;
    activeRentals: number;
    activeEvents: number;
    newUsersThisMonth: number;
    newOrganizationsThisMonth: number;
  }> {
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    const [
      totalOrganizations,
      totalUsers,
      activeRentals,
      activeEvents,
      newUsersThisMonth,
      newOrganizationsThisMonth,
    ] = await Promise.all([
      this.organizationRepository.count(),
      this.userRepository.count(),
      this.rentalAssignmentRepository.count({
        where: { status: RentalAssignmentStatus.ACTIVE },
      }),
      this.eventRepository.count({
        where: { status: In([EventStatus.ACTIVE, EventStatus.TEST]) },
      }),
      this.userRepository.count({
        where: { createdAt: MoreThanOrEqual(startOfMonth) },
      }),
      this.organizationRepository.count({
        where: { createdAt: MoreThanOrEqual(startOfMonth) },
      }),
    ]);

    return {
      totalOrganizations,
      totalUsers,
      activeRentals,
      activeEvents,
      newUsersThisMonth,
      newOrganizationsThisMonth,
    };
  }

  async getRevenueStats(startDate?: string, endDate?: string): Promise<{
    totalRevenue: number;
    rentalRevenue: number;
  }> {
    const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), 0, 1);
    const end = endDate ? new Date(endDate) : new Date();

    const rentalRevenue = await this.rentalAssignmentRepository
      .createQueryBuilder('assignment')
      .select('SUM(assignment.totalAmount)', 'total')
      .where('assignment.status IN (:...statuses)', {
        statuses: [RentalAssignmentStatus.ACTIVE, RentalAssignmentStatus.RETURNED],
      })
      .andWhere('assignment.createdAt BETWEEN :start AND :end', { start, end })
      .getRawOne();

    const rentalTotal = Number(rentalRevenue?.total || 0);

    return {
      totalRevenue: rentalTotal,
      rentalRevenue: rentalTotal,
    };
  }

  // === Audit Logs ===

  async findAuditLogs(
    queryDto: QueryAuditLogsDto,
  ): Promise<{ data: AdminAuditLog[]; total: number; page: number; limit: number }> {
    const { adminUserId, organizationId, action, startDate, endDate, page = 1, limit = 20 } = queryDto;

    const queryBuilder = this.auditLogRepository
      .createQueryBuilder('log')
      .leftJoinAndSelect('log.adminUser', 'admin')
      .leftJoinAndSelect('log.organization', 'org');

    if (adminUserId) {
      queryBuilder.andWhere('log.adminUserId = :adminUserId', { adminUserId });
    }

    if (organizationId) {
      queryBuilder.andWhere('log.organizationId = :organizationId', { organizationId });
    }

    if (action) {
      queryBuilder.andWhere('log.action = :action', { action });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('log.createdAt BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      });
    }

    const total = await queryBuilder.getCount();

    const data = await queryBuilder
      .orderBy('log.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return { data, total, page, limit };
  }

  // === Subscription Config ===

  async getSubscriptionConfig(): Promise<SubscriptionConfig | null> {
    // Get the first active subscription config (there should only be one)
    return this.subscriptionConfigRepository.findOne({
      where: { isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  async getAllSubscriptionConfigs(): Promise<SubscriptionConfig[]> {
    return this.subscriptionConfigRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async createSubscriptionConfig(
    createDto: CreateSubscriptionConfigDto,
  ): Promise<SubscriptionConfig> {
    const config = this.subscriptionConfigRepository.create({
      ...createDto,
      isActive: createDto.isActive ?? true,
      features: createDto.features ?? {},
    });

    await this.subscriptionConfigRepository.save(config);

    this.logger.log(`Subscription config created: ${config.name}`);

    return config;
  }

  async updateSubscriptionConfig(
    id: string,
    updateDto: UpdateSubscriptionConfigDto,
  ): Promise<SubscriptionConfig> {
    const config = await this.subscriptionConfigRepository.findOne({
      where: { id },
    });

    if (!config) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Subscription-Konfiguration nicht gefunden',
      });
    }

    Object.assign(config, updateDto);
    await this.subscriptionConfigRepository.save(config);

    this.logger.log(`Subscription config updated: ${config.name}`);

    return config;
  }

  async upsertSubscriptionConfig(
    updateDto: UpdateSubscriptionConfigDto,
  ): Promise<SubscriptionConfig> {
    let config = await this.subscriptionConfigRepository.findOne({
      where: { isActive: true },
      order: { createdAt: 'DESC' },
    });

    if (config) {
      Object.assign(config, updateDto);
    } else {
      config = this.subscriptionConfigRepository.create({
        name: updateDto.name ?? 'Monatsabo',
        ...updateDto,
        isActive: true,
        features: {},
      });
    }

    await this.subscriptionConfigRepository.save(config);
    this.logger.log(`Subscription config upserted: ${config.name}`);
    return config;
  }

  async deleteSubscriptionConfig(id: string): Promise<void> {
    const config = await this.subscriptionConfigRepository.findOne({
      where: { id },
    });

    if (!config) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Subscription-Konfiguration nicht gefunden',
      });
    }

    await this.subscriptionConfigRepository.remove(config);

    this.logger.log(`Subscription config deleted: ${config.name}`);
  }

  // === Private Helper ===

  private async createAuditLog(
    adminUserId: string,
    organizationId: string | null,
    action: AdminAction,
    resourceType: string,
    resourceId: string | null,
    details: Record<string, unknown>,
    ipAddress: string,
    userAgent?: string,
    reason?: string,
  ): Promise<void> {
    const log = this.auditLogRepository.create({
      adminUserId,
      organizationId,
      action,
      resourceType,
      resourceId,
      details,
      ipAddress,
      userAgent: userAgent || null,
      reason: reason || null,
    });

    await this.auditLogRepository.save(log);
  }
}
