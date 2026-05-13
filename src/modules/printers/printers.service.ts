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
import { Repository, IsNull } from 'typeorm';
import { Printer, Device, User, UserOrganization } from '../../database/entities';
import { PrinterType, PrinterConnectionType } from '../../database/entities/printer.entity';
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

  /**
   * Upsert the printers a device's agent reports from its local config.yaml.
   * The agent's config is the source of truth for hardware-fixed fields
   * (name, type, connection, USB IDs, paperWidth) — `hasCashDrawer` and the
   * organization assignment stay under admin control and are NOT touched here.
   */
  async syncFromAgent(
    deviceId: string,
    organizationId: string | null,
    items: Array<{
      localId: string;
      name: string;
      type: PrinterType;
      connectionType: PrinterConnectionType;
      connectionConfig?: Record<string, unknown>;
      paperWidth?: number;
    }>,
  ): Promise<Array<{ id: string; localId: string }>> {
    const result: Array<{ id: string; localId: string }> = [];

    for (const item of items) {
      let printer = await this.printerRepository.findOne({
        where: { deviceId, agentLocalId: item.localId },
      });

      if (!printer) {
        // Fallback: maybe the printer existed before this column was added —
        // pick the first one for this device that has no localId.
        printer = await this.printerRepository.findOne({
          where: { deviceId, agentLocalId: IsNull() },
        });
      }

      const fields: Partial<Printer> = {
        agentLocalId: item.localId,
        name: item.name,
        type: item.type,
        connectionType: item.connectionType,
        connectionConfig: (item.connectionConfig ?? {}) as Printer['connectionConfig'],
        paperWidth: item.paperWidth ?? 80,
        isActive: true,
      };

      if (printer) {
        Object.assign(printer, fields);
        const saved = await this.printerRepository.save(printer);
        result.push({ id: saved.id, localId: item.localId });
      } else {
        const created = this.printerRepository.create({
          ...fields,
          deviceId,
          organizationId,
          hasCashDrawer: false,
        });
        const saved = await this.printerRepository.save(created);
        result.push({ id: saved.id, localId: item.localId });
      }
    }

    return result;
  }

  async updateOnlineStatus(printerId: string, isOnline: boolean): Promise<void> {
    // Always refresh last_seen_at so the admin UI knows the agent is reachable,
    // even if the underlying USB printer reports offline (e.g. cable unplugged).
    await this.printerRepository.update(
      { id: printerId },
      { isOnline, lastSeenAt: new Date() },
    );
  }

  async testPrint(
    organizationId: string,
    printerId: string,
    user: User,
  ): Promise<{ success: boolean; message: string }> {
    await this.checkPermission(organizationId, user.id, 'devices');
    const printer = await this.findOne(organizationId, printerId, user);
    return this.dispatchTestPrint(printer);
  }

  /** Super-admin variant: bypasses org-membership check. */
  async testPrintAsAdmin(printerId: string): Promise<{ success: boolean; message: string }> {
    const printer = await this.printerRepository.findOne({ where: { id: printerId } });
    if (!printer) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Drucker nicht gefunden',
      });
    }
    // Admin test prints check agent reachability via last_seen_at instead of the
    // strict isOnline flag, so we can also send test jobs when the underlying
    // USB device isn't fully connected — the agent will report the failure back.
    return this.dispatchTestPrint(printer, { requireOnline: false });
  }

  private async dispatchTestPrint(
    printer: Printer,
    options: { requireOnline?: boolean } = { requireOnline: true },
  ): Promise<{ success: boolean; message: string }> {
    if (!printer.isActive) {
      return { success: false, message: 'Drucker ist deaktiviert' };
    }
    if (options.requireOnline && !printer.isOnline) {
      return { success: false, message: 'Drucker ist offline' };
    }
    if (!options.requireOnline) {
      const lastSeen = printer.lastSeenAt ? new Date(printer.lastSeenAt).getTime() : 0;
      if (!lastSeen || Date.now() - lastSeen > 60_000) {
        return { success: false, message: 'Drucker-Agent ist nicht erreichbar' };
      }
    }
    if (!printer.organizationId) {
      return { success: false, message: 'Drucker ist keiner Organisation zugeordnet' };
    }

    // Emit a real PRINTER_JOB event so the agent renders + prints the bundled
    // "receipt" template with a small test payload.
    const jobId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    this.gatewayService.sendPrintJobToAgent(printer.organizationId, {
      jobId,
      printerId: printer.id,
      templateName: '_admin_test',
      copies: 1,
      payload: {
        printerName: printer.name,
        jobId,
        timestamp: new Date().toLocaleString('de-DE', {
          dateStyle: 'short',
          timeStyle: 'short',
        }),
        body: 'Test-Druck aus dem Super-Admin-Interface.',
      },
    });

    this.logger.log(`Test print dispatched for printer ${printer.name} (${printer.id}) job=${jobId}`);
    return { success: true, message: 'Testdruck wurde an den Drucker gesendet' };
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
