import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PrintTemplate, User, UserOrganization } from '../../database/entities';
import { PrintTemplateType } from '../../database/entities/print-template.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { PaginationDto, PaginatedResult, createPaginatedResult } from '../../common/dto/pagination.dto';
import { CreatePrintTemplateDto, UpdatePrintTemplateDto } from './dto';

@Injectable()
export class PrintTemplatesService {
  private readonly logger = new Logger(PrintTemplatesService.name);

  constructor(
    @InjectRepository(PrintTemplate)
    private readonly printTemplateRepository: Repository<PrintTemplate>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
  ) {}

  async create(
    organizationId: string,
    createDto: CreatePrintTemplateDto,
    user: User,
  ): Promise<PrintTemplate> {
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

    // If this is marked as default, unset other defaults of the same type
    if (createDto.isDefault) {
      await this.unsetDefaultsForType(organizationId, createDto.type);
    }

    const template = this.printTemplateRepository.create({
      organizationId,
      name: createDto.name,
      type: createDto.type,
      template: createDto.template || {},
      isDefault: createDto.isDefault || false,
    });

    await this.printTemplateRepository.save(template);
    this.logger.log(`Print template created: ${template.name} (${template.id})`);

    return template;
  }

  async findAll(
    organizationId: string,
    user: User,
    pagination: PaginationDto,
  ): Promise<PaginatedResult<PrintTemplate>> {
    await this.checkMembership(organizationId, user.id);

    const { page = 1, limit = 50 } = pagination;
    const skip = (page - 1) * limit;

    const [items, total] = await this.printTemplateRepository.findAndCount({
      where: { organizationId },
      skip,
      take: limit,
      order: { type: 'ASC', name: 'ASC' },
    });

    return createPaginatedResult(items, total, page, limit);
  }

  async findOne(organizationId: string, templateId: string, user: User): Promise<PrintTemplate> {
    await this.checkMembership(organizationId, user.id);

    const template = await this.printTemplateRepository.findOne({
      where: { id: templateId, organizationId },
    });

    if (!template) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Druckvorlage nicht gefunden',
      });
    }

    return template;
  }

  async findDefaultByType(
    organizationId: string,
    type: PrintTemplateType,
  ): Promise<PrintTemplate | null> {
    return this.printTemplateRepository.findOne({
      where: { organizationId, type, isDefault: true },
    });
  }

  async update(
    organizationId: string,
    templateId: string,
    updateDto: UpdatePrintTemplateDto,
    user: User,
  ): Promise<PrintTemplate> {
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

    const template = await this.findOne(organizationId, templateId, user);

    // If this is being set as default, unset other defaults of the same type
    if (updateDto.isDefault && !template.isDefault) {
      await this.unsetDefaultsForType(organizationId, template.type);
    }

    Object.assign(template, updateDto);
    await this.printTemplateRepository.save(template);

    this.logger.log(`Print template updated: ${template.name} (${template.id})`);

    return template;
  }

  async remove(organizationId: string, templateId: string, user: User): Promise<void> {
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

    const template = await this.findOne(organizationId, templateId, user);
    await this.printTemplateRepository.remove(template);

    this.logger.log(`Print template deleted: ${template.name} (${template.id})`);
  }

  async preview(
    organizationId: string,
    templateId: string,
    user: User,
  ): Promise<{ html: string }> {
    await this.checkMembership(organizationId, user.id);

    const template = await this.findOne(organizationId, templateId, user);

    // Generate preview HTML based on template definition
    // For now, return a simple preview
    const html = this.generatePreviewHtml(template);

    return { html };
  }

  private generatePreviewHtml(template: PrintTemplate): string {
    // Basic preview generation - in production this would render the actual template
    return `
      <div style="font-family: monospace; padding: 20px; border: 1px solid #ccc; max-width: 300px;">
        <h3>${template.name}</h3>
        <p>Typ: ${template.type}</p>
        <hr/>
        <p style="text-align: center;">--- Vorschau ---</p>
        <p>Bestellnummer: #001</p>
        <p>Tisch: 12</p>
        <hr/>
        <p>1x Beispielprodukt</p>
        <p>2x Weiteres Produkt</p>
        <hr/>
        <p style="text-align: center;">Danke für Ihren Einkauf!</p>
      </div>
    `;
  }

  private async unsetDefaultsForType(
    organizationId: string,
    type: PrintTemplateType,
  ): Promise<void> {
    await this.printTemplateRepository.update(
      { organizationId, type, isDefault: true },
      { isDefault: false },
    );
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
