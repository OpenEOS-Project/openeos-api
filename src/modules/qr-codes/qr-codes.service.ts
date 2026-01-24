import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { QrCode, User, UserOrganization } from '../../database/entities';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { PaginationDto, PaginatedResult, createPaginatedResult } from '../../common/dto/pagination.dto';
import { CreateQrCodeDto, UpdateQrCodeDto, BulkCreateQrCodesDto } from './dto';

@Injectable()
export class QrCodesService {
  private readonly logger = new Logger(QrCodesService.name);

  constructor(
    @InjectRepository(QrCode)
    private readonly qrCodeRepository: Repository<QrCode>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
  ) {}

  async create(
    organizationId: string,
    createDto: CreateQrCodeDto,
    user: User,
  ): Promise<QrCode> {
    await this.checkRole(organizationId, user.id, OrganizationRole.MANAGER);

    const code = this.generateCode();

    const qrCode = this.qrCodeRepository.create({
      organizationId,
      eventId: createDto.eventId || null,
      code,
      type: createDto.type,
      tableNumber: createDto.tableNumber || null,
      name: createDto.name || null,
      isActive: true,
      scanCount: 0,
    });

    await this.qrCodeRepository.save(qrCode);
    this.logger.log(`QR code created: ${qrCode.code} (${qrCode.id})`);

    return qrCode;
  }

  async bulkCreate(
    organizationId: string,
    bulkDto: BulkCreateQrCodesDto,
    user: User,
  ): Promise<QrCode[]> {
    await this.checkRole(organizationId, user.id, OrganizationRole.MANAGER);

    const qrCodes: QrCode[] = [];
    const startNum = bulkDto.startNumber || 1;

    for (let i = 0; i < bulkDto.count; i++) {
      const num = startNum + i;
      const code = this.generateCode();
      const tableNumber = bulkDto.prefix
        ? `${bulkDto.prefix}${String(num).padStart(2, '0')}`
        : String(num);

      const qrCode = this.qrCodeRepository.create({
        organizationId,
        eventId: bulkDto.eventId || null,
        code,
        type: bulkDto.type,
        tableNumber: bulkDto.type === 'table' ? tableNumber : null,
        name: bulkDto.prefix ? `${bulkDto.prefix} ${num}` : `QR ${num}`,
        isActive: true,
        scanCount: 0,
      });

      qrCodes.push(qrCode);
    }

    await this.qrCodeRepository.save(qrCodes);
    this.logger.log(`Bulk created ${qrCodes.length} QR codes`);

    return qrCodes;
  }

  async findAll(
    organizationId: string,
    user: User,
    pagination: PaginationDto,
  ): Promise<PaginatedResult<QrCode>> {
    await this.checkMembership(organizationId, user.id);

    const { page = 1, limit = 50 } = pagination;
    const skip = (page - 1) * limit;

    const [items, total] = await this.qrCodeRepository.findAndCount({
      where: { organizationId },
      relations: ['event'],
      skip,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return createPaginatedResult(items, total, page, limit);
  }

  async findOne(organizationId: string, qrCodeId: string, user: User): Promise<QrCode> {
    await this.checkMembership(organizationId, user.id);

    const qrCode = await this.qrCodeRepository.findOne({
      where: { id: qrCodeId, organizationId },
      relations: ['event'],
    });

    if (!qrCode) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'QR-Code nicht gefunden',
      });
    }

    return qrCode;
  }

  async findByCode(code: string): Promise<QrCode | null> {
    const qrCode = await this.qrCodeRepository.findOne({
      where: { code, isActive: true },
      relations: ['organization', 'event'],
    });

    if (qrCode) {
      // Increment scan count
      qrCode.scanCount += 1;
      qrCode.lastScannedAt = new Date();
      await this.qrCodeRepository.save(qrCode);
    }

    return qrCode;
  }

  async update(
    organizationId: string,
    qrCodeId: string,
    updateDto: UpdateQrCodeDto,
    user: User,
  ): Promise<QrCode> {
    await this.checkRole(organizationId, user.id, OrganizationRole.MANAGER);

    const qrCode = await this.findOne(organizationId, qrCodeId, user);
    Object.assign(qrCode, updateDto);
    await this.qrCodeRepository.save(qrCode);

    this.logger.log(`QR code updated: ${qrCode.code} (${qrCode.id})`);

    return qrCode;
  }

  async remove(organizationId: string, qrCodeId: string, user: User): Promise<void> {
    await this.checkRole(organizationId, user.id, OrganizationRole.MANAGER);

    const qrCode = await this.findOne(organizationId, qrCodeId, user);
    await this.qrCodeRepository.remove(qrCode);

    this.logger.log(`QR code deleted: ${qrCode.code} (${qrCode.id})`);
  }

  async getImage(
    organizationId: string,
    qrCodeId: string,
    user: User,
    format: 'png' | 'svg' = 'svg',
  ): Promise<{ data: string; contentType: string }> {
    await this.checkMembership(organizationId, user.id);

    const qrCode = await this.findOne(organizationId, qrCodeId, user);

    // Generate QR code URL
    const baseUrl = process.env.ONLINE_ORDER_BASE_URL || 'https://order.openeos.de';
    const qrUrl = `${baseUrl}/scan/${qrCode.code}`;

    // For now, return a simple SVG placeholder
    // In production, use a QR code library like 'qrcode'
    const svg = this.generateQrSvgPlaceholder(qrUrl, qrCode.code);

    if (format === 'svg') {
      return {
        data: svg,
        contentType: 'image/svg+xml',
      };
    }

    // For PNG, would need to use a library like 'qrcode' or 'sharp'
    // For now, return SVG as fallback
    return {
      data: svg,
      contentType: 'image/svg+xml',
    };
  }

  private generateCode(): string {
    // Generate a short, unique code
    return uuidv4().substring(0, 8).toUpperCase();
  }

  private generateQrSvgPlaceholder(url: string, code: string): string {
    // Simple SVG placeholder - in production, use proper QR library
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
      <rect width="200" height="200" fill="white"/>
      <rect x="20" y="20" width="160" height="160" fill="white" stroke="black" stroke-width="2"/>
      <text x="100" y="90" text-anchor="middle" font-family="monospace" font-size="14">QR Code</text>
      <text x="100" y="110" text-anchor="middle" font-family="monospace" font-size="12" font-weight="bold">${code}</text>
      <text x="100" y="130" text-anchor="middle" font-family="monospace" font-size="8" fill="gray">${url}</text>
    </svg>`;
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
