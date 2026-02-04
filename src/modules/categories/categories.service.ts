import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Category, User, UserOrganization, Event } from '../../database/entities';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { CreateCategoryDto, UpdateCategoryDto, ReorderCategoriesDto } from './dto';
import { GatewayService } from '../gateway/gateway.service';

@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
  ) {}

  async create(
    eventId: string,
    createDto: CreateCategoryDto,
    user: User,
  ): Promise<Category> {
    const event = await this.getEventAndCheckRole(eventId, user.id, OrganizationRole.MANAGER);

    const category = this.categoryRepository.create({
      eventId: event.id,
      ...createDto,
    });

    await this.categoryRepository.save(category);
    this.logger.log(`Category created: ${category.name} (${category.id})`);

    // Notify menu displays
    this.gatewayService.notifyCategoryUpdated(event.organizationId, eventId, {
      id: category.id,
      name: category.name,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
    });

    return category;
  }

  async findAll(eventId: string, user: User): Promise<Category[]> {
    await this.getEventAndCheckMembership(eventId, user.id);

    return this.categoryRepository.find({
      where: { eventId },
      relations: ['children', 'products'],
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }

  async findOne(eventId: string, categoryId: string, user: User): Promise<Category> {
    await this.getEventAndCheckMembership(eventId, user.id);

    const category = await this.categoryRepository.findOne({
      where: { id: categoryId, eventId },
      relations: ['children', 'products', 'parent'],
    });

    if (!category) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Kategorie nicht gefunden',
      });
    }

    return category;
  }

  async update(
    eventId: string,
    categoryId: string,
    updateDto: UpdateCategoryDto,
    user: User,
  ): Promise<Category> {
    const event = await this.getEventAndCheckRole(eventId, user.id, OrganizationRole.MANAGER);

    const category = await this.findOne(eventId, categoryId, user);
    Object.assign(category, updateDto);
    await this.categoryRepository.save(category);

    this.logger.log(`Category updated: ${category.name} (${category.id})`);

    // Notify menu displays
    this.gatewayService.notifyCategoryUpdated(event.organizationId, eventId, {
      id: category.id,
      name: category.name,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
    });

    return category;
  }

  async remove(eventId: string, categoryId: string, user: User): Promise<void> {
    const event = await this.getEventAndCheckRole(eventId, user.id, OrganizationRole.ADMIN);

    const category = await this.findOne(eventId, categoryId, user);
    await this.categoryRepository.remove(category);

    this.logger.log(`Category deleted: ${category.name} (${category.id})`);

    // Notify menu displays
    this.gatewayService.notifyCategoryDeleted(event.organizationId, eventId, categoryId);
  }

  async reorder(
    eventId: string,
    reorderDto: ReorderCategoriesDto,
    user: User,
  ): Promise<void> {
    const event = await this.getEventAndCheckRole(eventId, user.id, OrganizationRole.MANAGER);

    for (let i = 0; i < reorderDto.categoryIds.length; i++) {
      await this.categoryRepository.update(
        { id: reorderDto.categoryIds[i], eventId },
        { sortOrder: i },
      );
    }

    this.logger.log(`Categories reordered for event ${eventId}`);

    // Notify menu displays to refresh
    this.gatewayService.notifyMenuRefresh(event.organizationId, eventId, 'reorder');
  }

  private async getEvent(eventId: string): Promise<Event> {
    const event = await this.eventRepository.findOne({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Event nicht gefunden',
      });
    }

    return event;
  }

  private async getEventAndCheckMembership(eventId: string, userId: string): Promise<Event> {
    const event = await this.getEvent(eventId);

    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId: event.organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Kein Zugriff auf dieses Event',
      });
    }

    return event;
  }

  private async getEventAndCheckRole(
    eventId: string,
    userId: string,
    requiredRole: OrganizationRole,
  ): Promise<Event> {
    const event = await this.getEvent(eventId);

    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId: event.organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Kein Zugriff auf dieses Event',
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

    return event;
  }
}
