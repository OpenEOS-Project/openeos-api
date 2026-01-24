import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, In } from 'typeorm';
import {
  Organization,
  User,
  CreditPurchase,
  CreditPackage,
  SubscriptionConfig,
  Invoice,
  RentalHardware,
  RentalAssignment,
  AdminAuditLog,
  Event,
  Order,
} from '../../database/entities';
import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import { CreditPaymentStatus } from '../../database/entities/credit-purchase.entity';
import { InvoiceStatus } from '../../database/entities/invoice.entity';
import { RentalHardwareStatus } from '../../database/entities/rental-hardware.entity';
import { RentalAssignmentStatus } from '../../database/entities/rental-assignment.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import {
  QueryOrganizationsDto,
  QueryUsersDto,
  QueryPurchasesDto,
  QueryInvoicesAdminDto,
  QueryAuditLogsDto,
  QueryRentalHardwareDto,
  QueryRentalAssignmentsAdminDto,
  QueryCreditPackagesDto,
  AdjustCreditsDto,
  SetDiscountDto,
  AccessOrganizationDto,
  CreateRentalHardwareDto,
  UpdateRentalHardwareDto,
  CreateRentalAssignmentDto,
  UpdateRentalAssignmentDto,
  UpdateOrganizationAdminDto,
  CreateSubscriptionConfigDto,
  UpdateSubscriptionConfigDto,
  CreateCreditPackageDto,
  UpdateCreditPackageDto,
} from './dto';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(CreditPurchase)
    private readonly creditPurchaseRepository: Repository<CreditPurchase>,
    @InjectRepository(CreditPackage)
    private readonly creditPackageRepository: Repository<CreditPackage>,
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

  async adjustCredits(
    orgId: string,
    adjustDto: AdjustCreditsDto,
    adminUserId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<Organization> {
    const org = await this.getOrganization(orgId);
    const before = { eventCredits: org.eventCredits };

    org.eventCredits += adjustDto.amount;
    if (org.eventCredits < 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Credits können nicht negativ werden',
      });
    }

    await this.organizationRepository.save(org);

    await this.createAuditLog(
      adminUserId,
      orgId,
      AdminAction.CREDIT_ADJUSTMENT,
      'organization',
      orgId,
      { before, after: { eventCredits: org.eventCredits }, adjustment: adjustDto.amount, reason: adjustDto.reason },
      ipAddress,
      userAgent,
    );

    this.logger.log(
      `Credits adjusted for org ${orgId}: ${adjustDto.amount} (reason: ${adjustDto.reason})`,
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

    const queryBuilder = this.userRepository.createQueryBuilder('user');

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

  // === Purchases ===

  async findAllPurchases(
    queryDto: QueryPurchasesDto,
  ): Promise<{ data: CreditPurchase[]; total: number; page: number; limit: number }> {
    const { organizationId, status, startDate, endDate, page = 1, limit = 20 } = queryDto;

    const queryBuilder = this.creditPurchaseRepository
      .createQueryBuilder('purchase')
      .leftJoinAndSelect('purchase.organization', 'org')
      .leftJoinAndSelect('purchase.package', 'pkg');

    if (organizationId) {
      queryBuilder.andWhere('purchase.organizationId = :organizationId', { organizationId });
    }

    if (status) {
      queryBuilder.andWhere('purchase.paymentStatus = :status', { status });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('purchase.createdAt BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      });
    }

    const total = await queryBuilder.getCount();

    const data = await queryBuilder
      .orderBy('purchase.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return { data, total, page, limit };
  }

  async completePurchase(
    purchaseId: string,
    adminUserId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<CreditPurchase> {
    const purchase = await this.creditPurchaseRepository.findOne({
      where: { id: purchaseId },
      relations: ['organization'],
    });

    if (!purchase) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Kauf nicht gefunden',
      });
    }

    if (purchase.paymentStatus !== CreditPaymentStatus.PENDING) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Kauf wurde bereits abgeschlossen',
      });
    }

    purchase.paymentStatus = CreditPaymentStatus.COMPLETED;
    purchase.completedAt = new Date();
    await this.creditPurchaseRepository.save(purchase);

    // Add credits to organization
    await this.organizationRepository.increment(
      { id: purchase.organizationId },
      'eventCredits',
      purchase.credits,
    );

    await this.createAuditLog(
      adminUserId,
      purchase.organizationId,
      AdminAction.COMPLETE_PURCHASE,
      'credit_purchase',
      purchaseId,
      { credits: purchase.credits, amount: purchase.amount },
      ipAddress,
      userAgent,
    );

    this.logger.log(`Purchase completed by admin: ${purchaseId}`);

    return purchase;
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

  // === Statistics ===

  async getOverviewStats(): Promise<{
    totalOrganizations: number;
    totalUsers: number;
    totalCredits: number;
    pendingPurchases: number;
    activeRentals: number;
  }> {
    const [
      totalOrganizations,
      totalUsers,
      totalCreditsResult,
      pendingPurchases,
      activeRentals,
    ] = await Promise.all([
      this.organizationRepository.count(),
      this.userRepository.count(),
      this.organizationRepository
        .createQueryBuilder('org')
        .select('SUM(org.eventCredits)', 'total')
        .getRawOne(),
      this.creditPurchaseRepository.count({
        where: { paymentStatus: CreditPaymentStatus.PENDING },
      }),
      this.rentalAssignmentRepository.count({
        where: { status: RentalAssignmentStatus.ACTIVE },
      }),
    ]);

    return {
      totalOrganizations,
      totalUsers,
      totalCredits: Number(totalCreditsResult?.total || 0),
      pendingPurchases,
      activeRentals,
    };
  }

  async getRevenueStats(startDate?: string, endDate?: string): Promise<{
    totalRevenue: number;
    creditRevenue: number;
    rentalRevenue: number;
  }> {
    const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), 0, 1);
    const end = endDate ? new Date(endDate) : new Date();

    const [creditRevenue, rentalRevenue] = await Promise.all([
      this.creditPurchaseRepository
        .createQueryBuilder('purchase')
        .select('SUM(purchase.amount)', 'total')
        .where('purchase.paymentStatus = :status', { status: CreditPaymentStatus.COMPLETED })
        .andWhere('purchase.completedAt BETWEEN :start AND :end', { start, end })
        .getRawOne(),
      this.rentalAssignmentRepository
        .createQueryBuilder('assignment')
        .select('SUM(assignment.totalAmount)', 'total')
        .where('assignment.status IN (:...statuses)', {
          statuses: [RentalAssignmentStatus.ACTIVE, RentalAssignmentStatus.RETURNED],
        })
        .andWhere('assignment.createdAt BETWEEN :start AND :end', { start, end })
        .getRawOne(),
    ]);

    const creditTotal = Number(creditRevenue?.total || 0);
    const rentalTotal = Number(rentalRevenue?.total || 0);

    return {
      totalRevenue: creditTotal + rentalTotal,
      creditRevenue: creditTotal,
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

  // === Credit Packages ===

  async findAllCreditPackages(
    queryDto: QueryCreditPackagesDto,
  ): Promise<{ data: CreditPackage[]; total: number; page: number; limit: number }> {
    const { search, isActive, page = 1, limit = 20 } = queryDto;

    const queryBuilder = this.creditPackageRepository.createQueryBuilder('pkg');

    if (search) {
      queryBuilder.where(
        '(pkg.name ILIKE :search OR pkg.slug ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    if (isActive !== undefined) {
      queryBuilder.andWhere('pkg.isActive = :isActive', { isActive });
    }

    const total = await queryBuilder.getCount();

    const data = await queryBuilder
      .orderBy('pkg.sortOrder', 'ASC')
      .addOrderBy('pkg.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return { data, total, page, limit };
  }

  async getCreditPackage(id: string): Promise<CreditPackage> {
    const pkg = await this.creditPackageRepository.findOne({
      where: { id },
    });

    if (!pkg) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Credit-Paket nicht gefunden',
      });
    }

    return pkg;
  }

  async createCreditPackage(
    createDto: CreateCreditPackageDto,
  ): Promise<CreditPackage> {
    // Check if slug already exists
    const existing = await this.creditPackageRepository.findOne({
      where: { slug: createDto.slug },
    });

    if (existing) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Ein Paket mit diesem Slug existiert bereits',
      });
    }

    // Calculate pricePerCredit if not provided
    const pricePerCredit = createDto.pricePerCredit ?? createDto.price / createDto.credits;

    const pkg = this.creditPackageRepository.create({
      ...createDto,
      pricePerCredit,
      isActive: createDto.isActive ?? true,
      isFeatured: createDto.isFeatured ?? false,
      sortOrder: createDto.sortOrder ?? 0,
      savingsPercent: createDto.savingsPercent ?? 0,
    });

    await this.creditPackageRepository.save(pkg);

    this.logger.log(`Credit package created: ${pkg.name} (${pkg.slug})`);

    return pkg;
  }

  async updateCreditPackage(
    id: string,
    updateDto: UpdateCreditPackageDto,
  ): Promise<CreditPackage> {
    const pkg = await this.getCreditPackage(id);

    // Check if slug is being changed and already exists
    if (updateDto.slug && updateDto.slug !== pkg.slug) {
      const existing = await this.creditPackageRepository.findOne({
        where: { slug: updateDto.slug },
      });

      if (existing) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Ein Paket mit diesem Slug existiert bereits',
        });
      }
    }

    // Recalculate pricePerCredit if price or credits changed
    if ((updateDto.price !== undefined || updateDto.credits !== undefined) && !updateDto.pricePerCredit) {
      const newPrice = updateDto.price ?? Number(pkg.price);
      const newCredits = updateDto.credits ?? pkg.credits;
      updateDto.pricePerCredit = newPrice / newCredits;
    }

    Object.assign(pkg, updateDto);
    await this.creditPackageRepository.save(pkg);

    this.logger.log(`Credit package updated: ${pkg.name} (${pkg.slug})`);

    return pkg;
  }

  async deleteCreditPackage(id: string): Promise<void> {
    const pkg = await this.getCreditPackage(id);

    // Check if package has purchases
    const purchaseCount = await this.creditPurchaseRepository.count({
      where: { packageId: id },
    });

    if (purchaseCount > 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Paket kann nicht gelöscht werden, da bereits Käufe existieren. Deaktivieren Sie das Paket stattdessen.',
      });
    }

    await this.creditPackageRepository.remove(pkg);

    this.logger.log(`Credit package deleted: ${pkg.name} (${pkg.slug})`);
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
