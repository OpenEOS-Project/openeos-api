import {
  Injectable,
  NotFoundException,
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
  AdminAuditLog,
  Event,
  Order,
  Printer,
  Device,
  DiscoveredPrinter,
} from '../../database/entities';
import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import { InvoiceStatus } from '../../database/entities/invoice.entity';
import {
  DeviceType,
  DeviceStatus,
  type PrinterAgentInfo,
} from '../../database/entities/device.entity';
import {
  PrinterType,
  PrinterConnectionType,
  PrinterConnectionConfig,
} from '../../database/entities/printer.entity';

export interface AdminPrinterOverviewPrinter {
  id: string;
  name: string;
  type: PrinterType;
  connectionType: PrinterConnectionType;
  connectionConfig: PrinterConnectionConfig;
  fingerprint: string | null;
  paperWidth: number;
  hasCashDrawer: boolean;
  isActive: boolean;
  isOnline: boolean;
  lastSeenAt: Date | null;
}

export interface AdminPrinterOverviewAgent {
  deviceId: string;
  name: string;
  status: DeviceStatus;
  isOnline: boolean;
  lastSeenAt: Date | null;
  agentInfo: PrinterAgentInfo | null;
  discoveredCount: number;
  printers: AdminPrinterOverviewPrinter[];
}

/** `GET admin/printers`: Agents und Drucker je Organisation. */
export interface AdminPrinterOverviewEntry {
  organization: { id: string; name: string } | null;
  agents: AdminPrinterOverviewAgent[];
}
import { EventStatus } from '../../database/entities/event.entity';
import { GatewayService } from '../gateway/gateway.service';
import { PrinterAgentsService } from '../printers/printer-agents.service';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  redigiereAdminOrganisation,
  redigiereAdminUser,
  type RedigierterAdminUser,
} from './admin-redaction';
import {
  QueryOrganizationsDto,
  QueryUsersDto,
  QueryInvoicesAdminDto,
  QueryAuditLogsDto,
  SetDiscountDto,
  AccessOrganizationDto,
  UpdateOrganizationAdminDto,
  UpdateUserAdminDto,
  CreateSubscriptionConfigDto,
  UpdateSubscriptionConfigDto,
} from './dto';
import { endOfDay } from '../../common/utils/date-range.util';

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
    @Inject(forwardRef(() => PrinterAgentsService))
    private readonly printerAgentsService: PrinterAgentsService,
  ) {}

  // === Organizations ===

  async findAllOrganizations(queryDto: QueryOrganizationsDto): Promise<{
    data: Organization[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { search, page = 1, limit = 20 } = queryDto;

    const queryBuilder = this.organizationRepository.createQueryBuilder('org');

    if (search) {
      queryBuilder.where('(org.name ILIKE :search OR org.slug ILIKE :search)', {
        search: `%${search}%`,
      });
    }

    const total = await queryBuilder.getCount();

    const rohdaten = await queryBuilder
      .orderBy('org.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    const data = rohdaten.map(redigiereAdminOrganisation);

    return { data, total, page, limit };
  }

  async getOrganization(orgId: string): Promise<Organization> {
    const org = await this.organizationRepository.findOne({
      where: { id: orgId },
    });

    if (!org) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }

    return redigiereAdminOrganisation(org);
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
    const before = {
      discountPercent: org.discountPercent,
      discountValidUntil: org.discountValidUntil,
    };

    org.discountPercent = discountDto.discountPercent;
    org.discountValidUntil = discountDto.validUntil
      ? new Date(discountDto.validUntil)
      : null;
    await this.organizationRepository.save(org);

    await this.createAuditLog(
      adminUserId,
      orgId,
      AdminAction.SET_DISCOUNT,
      'organization',
      orgId,
      {
        before,
        after: {
          discountPercent: org.discountPercent,
          discountValidUntil: org.discountValidUntil,
        },
        reason: discountDto.reason,
      },
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
    const before = {
      discountPercent: org.discountPercent,
      discountValidUntil: org.discountValidUntil,
    };

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
        reason: ErrorReasons.SUPPORT_PIN_INVALID,
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

  async findAllUsers(queryDto: QueryUsersDto): Promise<{
    data: RedigierterAdminUser[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { search, isLocked, page = 1, limit = 20 } = queryDto;

    const queryBuilder = this.userRepository
      .createQueryBuilder('user')
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

    const rohdaten = await queryBuilder
      .orderBy('user.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    const data = rohdaten.map(redigiereAdminUser);

    return { data, total, page, limit };
  }

  async getUser(userId: string): Promise<RedigierterAdminUser> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['userOrganizations', 'userOrganizations.organization'],
    });

    if (!user) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        reason: ErrorReasons.USER_NOT_FOUND,
        message: 'Benutzer nicht gefunden',
      });
    }

    return redigiereAdminUser(user);
  }

  /**
   * Felder, die nur ein Super-Admin setzt — derzeit die eigene Obergrenze
   * fuer Organisationen (Support-Fall: "ich brauche eine sechste").
   */
  async updateUser(
    userId: string,
    updateDto: UpdateUserAdminDto,
    adminUserId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<RedigierterAdminUser> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['userOrganizations', 'userOrganizations.organization'],
    });

    if (!user) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.USER_NOT_FOUND,
        message: 'Benutzer nicht gefunden',
      });
    }

    const before = { organizationLimit: user.organizationLimit };
    if (updateDto.organizationLimit !== undefined) {
      user.organizationLimit = updateDto.organizationLimit;
    }
    await this.userRepository.save(user);

    await this.createAuditLog(
      adminUserId,
      null,
      AdminAction.EDIT_USER,
      'user',
      userId,
      {
        email: user.email,
        before,
        after: { organizationLimit: user.organizationLimit },
      },
      ipAddress,
      userAgent,
    );

    return redigiereAdminUser(user);
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
        reason: ErrorReasons.USER_NOT_FOUND,
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
    const {
      organizationId,
      status,
      startDate,
      endDate,
      page = 1,
      limit = 20,
    } = queryDto;

    const queryBuilder = this.invoiceRepository
      .createQueryBuilder('invoice')
      .leftJoinAndSelect('invoice.organization', 'org');

    if (organizationId) {
      queryBuilder.andWhere('invoice.organizationId = :organizationId', {
        organizationId,
      });
    }

    if (status) {
      queryBuilder.andWhere('invoice.status = :status', { status });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere(
        'invoice.createdAt BETWEEN :startDate AND :endDate',
        {
          startDate: new Date(startDate),
          endDate: endOfDay(endDate),
        },
      );
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
        reason: ErrorReasons.INVOICE_NOT_FOUND,
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
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId },
    });
    if (!device) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.DEVICE_NOT_FOUND,
        message: 'Gerät nicht gefunden',
      });
    }
    if (device.type === DeviceType.PRINTER_AGENT) {
      // Drucker samt Zuordnungen (Stationen, Bon-Workflow, Geraete) mit weg.
      await this.printerAgentsService.removeAgentDevice(device);
    } else {
      await this.deviceRepository.delete({ id: deviceId });
    }
    this.logger.log(`Admin deleted device ${deviceId}`);
  }

  async findAllDevices(params?: {
    type?: string;
    unassigned?: boolean;
  }): Promise<Device[]> {
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

  // === Printers (Admin) ===

  /**
   * Reine Uebersicht fuer den Super-Admin: je Organisation ihre
   * Drucker-Agenten mit Druckern und Online-Status. Pairing und Pflege
   * macht die Organisation selbst.
   */
  async printerOverview(params?: {
    organizationId?: string;
  }): Promise<AdminPrinterOverviewEntry[]> {
    const agentQb = this.deviceRepository
      .createQueryBuilder('device')
      .leftJoinAndSelect('device.organization', 'organization')
      .where('device.type = :type', { type: DeviceType.PRINTER_AGENT })
      .orderBy('organization.name', 'ASC', 'NULLS LAST')
      .addOrderBy('device.name', 'ASC');
    if (params?.organizationId) {
      agentQb.andWhere('device.organizationId = :orgId', {
        orgId: params.organizationId,
      });
    }
    const agents = await agentQb.getMany();
    if (agents.length === 0) return [];

    const agentIds = agents.map((a) => a.id);
    const [printers, discoveredRows, onlineIds] = await Promise.all([
      this.printerRepository.find({
        where: { deviceId: In(agentIds) },
        order: { name: 'ASC' },
      }),
      this.deviceRepository.manager
        .createQueryBuilder(DiscoveredPrinter, 'd')
        .select('d.deviceId', 'deviceId')
        .addSelect('COUNT(*)', 'count')
        .where('d.deviceId IN (:...agentIds)', { agentIds })
        .groupBy('d.deviceId')
        .getRawMany<{ deviceId: string; count: string }>(),
      this.gatewayService.getAllOnlineDeviceIds(),
    ]);
    const online = new Set(onlineIds);
    const discoveredCount = new Map(
      discoveredRows.map((r) => [r.deviceId, Number(r.count)]),
    );
    const printersByDevice = new Map<string, Printer[]>();
    for (const printer of printers) {
      if (!printer.deviceId) continue;
      const list = printersByDevice.get(printer.deviceId) ?? [];
      list.push(printer);
      printersByDevice.set(printer.deviceId, list);
    }

    const byOrg = new Map<string, AdminPrinterOverviewEntry>();
    for (const agent of agents) {
      const key = agent.organizationId ?? '';
      let entry = byOrg.get(key);
      if (!entry) {
        entry = {
          organization: agent.organization
            ? { id: agent.organization.id, name: agent.organization.name }
            : null,
          agents: [],
        };
        byOrg.set(key, entry);
      }
      entry.agents.push({
        deviceId: agent.id,
        name: agent.name,
        status: agent.status,
        isOnline: online.has(agent.id),
        lastSeenAt: agent.lastSeenAt,
        agentInfo: agent.agentInfo ?? null,
        discoveredCount: discoveredCount.get(agent.id) ?? 0,
        printers: (printersByDevice.get(agent.id) ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          connectionType: p.connectionType,
          connectionConfig: p.connectionConfig,
          fingerprint: p.fingerprint,
          paperWidth: p.paperWidth,
          hasCashDrawer: p.hasCashDrawer,
          isActive: p.isActive,
          isOnline: p.isOnline,
          lastSeenAt: p.lastSeenAt,
        })),
      });
    }
    return [...byOrg.values()];
  }

  // === Statistics ===

  async getOverviewStats(): Promise<{
    totalOrganizations: number;
    totalUsers: number;
    activeEvents: number;
    newUsersThisMonth: number;
    newOrganizationsThisMonth: number;
  }> {
    const startOfMonth = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      1,
    );

    const [
      totalOrganizations,
      totalUsers,
      activeEvents,
      newUsersThisMonth,
      newOrganizationsThisMonth,
    ] = await Promise.all([
      this.organizationRepository.count(),
      this.userRepository.count(),
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
      activeEvents,
      newUsersThisMonth,
      newOrganizationsThisMonth,
    };
  }

  /**
   * Einnahmen der Plattform im Zeitraum: freigeschaltete Veranstaltungen
   * (bezahlt oder auf Rechnung), nach Zahlungsdatum.
   */
  async getRevenueStats(
    startDate?: string,
    endDate?: string,
  ): Promise<{
    totalRevenue: number;
    eventRevenue: number;
  }> {
    const start = startDate
      ? new Date(startDate)
      : new Date(new Date().getFullYear(), 0, 1);
    const end = endDate ? endOfDay(endDate) : new Date();

    const row = await this.eventRepository
      .createQueryBuilder('event')
      .select('COALESCE(SUM(event.priceCharged), 0)', 'total')
      .where('event.billingStatus IN (:...statuses)', {
        statuses: ['paid', 'invoice'],
      })
      .andWhere('event.paidAt BETWEEN :start AND :end', { start, end })
      .getRawOne<{ total: string | null }>();

    const eventRevenue = Number(row?.total || 0);

    return {
      totalRevenue: eventRevenue,
      eventRevenue,
    };
  }

  // === Audit Logs ===

  async findAuditLogs(queryDto: QueryAuditLogsDto): Promise<{
    data: AdminAuditLog[];
    total: number;
    page: number;
    limit: number;
  }> {
    const {
      adminUserId,
      organizationId,
      action,
      startDate,
      endDate,
      page = 1,
      limit = 20,
    } = queryDto;

    const queryBuilder = this.auditLogRepository
      .createQueryBuilder('log')
      .leftJoinAndSelect('log.adminUser', 'admin')
      .leftJoinAndSelect('log.organization', 'org');

    if (adminUserId) {
      queryBuilder.andWhere('log.adminUserId = :adminUserId', { adminUserId });
    }

    if (organizationId) {
      queryBuilder.andWhere('log.organizationId = :organizationId', {
        organizationId,
      });
    }

    if (action) {
      queryBuilder.andWhere('log.action = :action', { action });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('log.createdAt BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: endOfDay(endDate),
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
        reason: ErrorReasons.SUBSCRIPTION_CONFIG_NOT_FOUND,
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
        reason: ErrorReasons.SUBSCRIPTION_CONFIG_NOT_FOUND,
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
