import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Device, User, UserOrganization, Organization } from '../../database/entities';
import { DeviceStatus, DeviceType } from '../../database/entities/device.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { PaginationDto, PaginatedResult, createPaginatedResult } from '../../common/dto/pagination.dto';
import { CreateDeviceDto, UpdateDeviceDto, RegisterDeviceDto } from './dto';

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
  ) {}

  async create(
    organizationId: string,
    createDto: CreateDeviceDto,
    user: User,
  ): Promise<Device> {
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

    // Generate unique device token
    const deviceToken = this.generateDeviceToken();

    const device = this.deviceRepository.create({
      organizationId,
      name: createDto.name,
      type: createDto.type,
      deviceToken,
      settings: createDto.settings || {},
      isActive: true,
    });

    await this.deviceRepository.save(device);
    this.logger.log(`Device created: ${device.name} (${device.id})`);

    return device;
  }

  async findAll(
    organizationId: string,
    user: User,
    pagination: PaginationDto,
  ): Promise<PaginatedResult<Device>> {
    await this.checkMembership(organizationId, user.id);

    const { page = 1, limit = 50 } = pagination;
    const skip = (page - 1) * limit;

    const [items, total] = await this.deviceRepository.findAndCount({
      where: { organizationId },
      skip,
      take: limit,
      order: { name: 'ASC' },
      select: {
        id: true,
        organizationId: true,
        name: true,
        type: true,
        // deviceToken: NOT included for security
        lastSeenAt: true,
        isActive: true,
        status: true,
        // verificationCode: NOT included for security
        verifiedAt: true,
        verifiedById: true,
        userAgent: true,
        settings: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return createPaginatedResult(items, total, page, limit);
  }

  async findOne(organizationId: string, deviceId: string, user: User): Promise<Device> {
    await this.checkMembership(organizationId, user.id);

    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, organizationId },
    });

    if (!device) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Gerät nicht gefunden',
      });
    }

    return device;
  }

  async update(
    organizationId: string,
    deviceId: string,
    updateDto: UpdateDeviceDto,
    user: User,
  ): Promise<Device> {
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

    const device = await this.findOne(organizationId, deviceId, user);
    Object.assign(device, updateDto);
    await this.deviceRepository.save(device);

    this.logger.log(`Device updated: ${device.name} (${device.id})`);

    return device;
  }

  async remove(organizationId: string, deviceId: string, user: User): Promise<void> {
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

    const device = await this.findOne(organizationId, deviceId, user);
    await this.deviceRepository.remove(device);

    this.logger.log(`Device deleted: ${device.name} (${device.id})`);
  }

  async regenerateToken(
    organizationId: string,
    deviceId: string,
    user: User,
  ): Promise<Device> {
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

    const device = await this.findOne(organizationId, deviceId, user);
    device.deviceToken = this.generateDeviceToken();
    await this.deviceRepository.save(device);

    this.logger.log(`Device token regenerated: ${device.name} (${device.id})`);

    return device;
  }

  async updateLastSeen(deviceToken: string): Promise<void> {
    await this.deviceRepository.update(
      { deviceToken },
      { lastSeenAt: new Date() },
    );
  }

  async findByToken(deviceToken: string): Promise<Device | null> {
    return this.deviceRepository.findOne({
      where: { deviceToken, isActive: true },
      relations: ['organization'],
    });
  }

  private generateDeviceToken(): string {
    return `dev_${uuidv4().replace(/-/g, '')}`;
  }

  private generateVerificationCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  // ============================================
  // Public Device Registration Methods
  // ============================================

  async registerDevice(registerDto: RegisterDeviceDto): Promise<{
    deviceId: string;
    deviceToken: string;
    verificationCode: string;
    organizationName: string;
  }> {
    // Find organization by slug
    const organization = await this.organizationRepository.findOne({
      where: { slug: registerDto.organizationSlug },
    });

    if (!organization) {
      throw new BadRequestException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }

    // Generate tokens
    const deviceToken = this.generateDeviceToken();
    const verificationCode = this.generateVerificationCode();

    // Create pending device
    const device = this.deviceRepository.create({
      organizationId: organization.id,
      name: registerDto.name,
      type: DeviceType.POS, // Default type, will be set during verification
      deviceToken,
      verificationCode,
      userAgent: registerDto.userAgent || null,
      status: DeviceStatus.PENDING,
      isActive: true,
    });

    await this.deviceRepository.save(device);
    this.logger.log(`Device registered: ${device.name} (${device.id}) - awaiting verification`);

    return {
      deviceId: device.id,
      deviceToken,
      verificationCode,
      organizationName: organization.name,
    };
  }

  async getDeviceStatus(deviceToken: string): Promise<{
    status: DeviceStatus;
    deviceId: string;
    organizationId?: string;
    organizationName?: string;
    deviceClass?: string;
  }> {
    const device = await this.deviceRepository.findOne({
      where: { deviceToken },
      relations: ['organization'],
    });

    if (!device) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Ungültiger Device-Token',
      });
    }

    return {
      status: device.status,
      deviceId: device.id,
      organizationId: device.status === DeviceStatus.VERIFIED ? device.organizationId : undefined,
      organizationName: device.status === DeviceStatus.VERIFIED ? device.organization?.name : undefined,
      deviceClass: device.status === DeviceStatus.VERIFIED ? device.type : undefined,
    };
  }

  async getDeviceInfo(deviceToken: string): Promise<{
    id: string;
    name: string;
    organizationId: string;
    organizationName: string;
    deviceClass: string;
    status: DeviceStatus;
  }> {
    const device = await this.deviceRepository.findOne({
      where: { deviceToken, isActive: true },
      relations: ['organization'],
    });

    if (!device) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Ungültiger Device-Token',
      });
    }

    if (device.status !== DeviceStatus.VERIFIED) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Gerät ist noch nicht verifiziert',
      });
    }

    return {
      id: device.id,
      name: device.name,
      organizationId: device.organizationId,
      organizationName: device.organization?.name || '',
      deviceClass: device.type,
      status: device.status,
    };
  }

  async logoutDevice(deviceToken: string): Promise<void> {
    const device = await this.deviceRepository.findOne({
      where: { deviceToken },
    });

    if (!device) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Ungültiger Device-Token',
      });
    }

    // Deactivate the device
    device.isActive = false;
    await this.deviceRepository.save(device);

    this.logger.log(`Device logged out: ${device.name} (${device.id})`);
  }

  async verifyDevice(
    organizationId: string,
    deviceId: string,
    code: string,
    user: User,
  ): Promise<Device> {
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, organizationId },
    });

    if (!device) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Gerät nicht gefunden',
      });
    }

    if (device.status === DeviceStatus.VERIFIED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Gerät ist bereits verifiziert',
      });
    }

    if (device.verificationCode !== code) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Ungültiger Verifizierungscode',
      });
    }

    device.status = DeviceStatus.VERIFIED;
    device.verifiedAt = new Date();
    device.verifiedById = user.id;
    device.verificationCode = null; // Clear the code after verification

    await this.deviceRepository.save(device);
    this.logger.log(`Device verified: ${device.name} (${device.id}) by user ${user.email}`);

    return device;
  }

  async blockDevice(
    organizationId: string,
    deviceId: string,
    user: User,
  ): Promise<Device> {
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

    const device = await this.findOne(organizationId, deviceId, user);
    device.status = DeviceStatus.BLOCKED;
    device.isActive = false;

    await this.deviceRepository.save(device);
    this.logger.log(`Device blocked: ${device.name} (${device.id}) by user ${user.email}`);

    return device;
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
