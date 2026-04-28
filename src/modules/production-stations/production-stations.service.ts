import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProductionStation, User, UserOrganization, Event, Printer } from '../../database/entities';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { CreateProductionStationDto, UpdateProductionStationDto } from './dto';

@Injectable()
export class ProductionStationsService {
  private readonly logger = new Logger(ProductionStationsService.name);

  constructor(
    @InjectRepository(ProductionStation)
    private readonly productionStationRepository: Repository<ProductionStation>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(Printer)
    private readonly printerRepository: Repository<Printer>,
  ) {}

  async create(
    eventId: string,
    createDto: CreateProductionStationDto,
    user: User,
  ): Promise<ProductionStation> {
    const event = await this.getEventAndCheckPermission(eventId, user.id, 'events');

    // Validate printer belongs to same organization
    if (createDto.printerId) {
      await this.validatePrinter(event.organizationId, createDto.printerId);
    }

    const station = this.productionStationRepository.create({
      eventId: event.id,
      ...createDto,
      printerId: createDto.printerId || null,
    });

    await this.productionStationRepository.save(station);
    this.logger.log(`Production station created: ${station.name} (${station.id})`);

    return station;
  }

  async findAll(eventId: string, user: User): Promise<ProductionStation[]> {
    await this.getEventAndCheckMembership(eventId, user.id);

    return this.productionStationRepository.find({
      where: { eventId },
      relations: ['printer'],
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }

  async findOne(eventId: string, stationId: string, user: User): Promise<ProductionStation> {
    await this.getEventAndCheckMembership(eventId, user.id);

    const station = await this.productionStationRepository.findOne({
      where: { id: stationId, eventId },
      relations: ['printer'],
    });

    if (!station) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Produktionsstandort nicht gefunden',
      });
    }

    return station;
  }

  async update(
    eventId: string,
    stationId: string,
    updateDto: UpdateProductionStationDto,
    user: User,
  ): Promise<ProductionStation> {
    const event = await this.getEventAndCheckPermission(eventId, user.id, 'events');

    const station = await this.findOne(eventId, stationId, user);

    // Validate printer belongs to same organization
    if (updateDto.printerId) {
      await this.validatePrinter(event.organizationId, updateDto.printerId);
    }

    Object.assign(station, updateDto);
    await this.productionStationRepository.save(station);

    this.logger.log(`Production station updated: ${station.name} (${station.id})`);

    return this.findOne(eventId, stationId, user);
  }

  async remove(eventId: string, stationId: string, user: User): Promise<void> {
    await this.getEventAndCheckAdmin(eventId, user.id);

    const station = await this.findOne(eventId, stationId, user);

    await this.productionStationRepository.remove(station);

    this.logger.log(`Production station deleted: ${station.name} (${station.id})`);
  }

  // Private helpers

  private async validatePrinter(organizationId: string, printerId: string): Promise<void> {
    const printer = await this.printerRepository.findOne({
      where: { id: printerId, organizationId },
    });

    if (!printer) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Drucker nicht gefunden oder gehört nicht zur selben Organisation',
      });
    }
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

  private async getEventAndCheckPermission(
    eventId: string,
    userId: string,
    permission: 'products' | 'events' | 'devices' | 'members' | 'shiftPlans',
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

    if (membership.role !== OrganizationRole.ADMIN && !membership.permissions?.[permission]) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }

    return event;
  }

  private async getEventAndCheckAdmin(
    eventId: string,
    userId: string,
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

    if (membership.role !== OrganizationRole.ADMIN) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }

    return event;
  }
}
