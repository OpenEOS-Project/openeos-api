import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RentalAssignment, RentalHardware } from '../../database/entities';
import { RentalAssignmentStatus } from '../../database/entities/rental-assignment.entity';
import { RentalHardwareStatus } from '../../database/entities/rental-hardware.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { QueryRentalsDto } from './dto';

@Injectable()
export class RentalsService {
  private readonly logger = new Logger(RentalsService.name);

  constructor(
    @InjectRepository(RentalAssignment)
    private readonly rentalAssignmentRepository: Repository<RentalAssignment>,
    @InjectRepository(RentalHardware)
    private readonly rentalHardwareRepository: Repository<RentalHardware>,
  ) {}

  async findAll(
    organizationId: string,
    queryDto: QueryRentalsDto,
  ): Promise<{ data: RentalAssignment[]; total: number; page: number; limit: number }> {
    const { status, startDate, endDate, page = 1, limit = 20 } = queryDto;

    const queryBuilder = this.rentalAssignmentRepository
      .createQueryBuilder('assignment')
      .leftJoinAndSelect('assignment.rentalHardware', 'hardware')
      .leftJoinAndSelect('assignment.event', 'event')
      .where('assignment.organizationId = :organizationId', { organizationId });

    if (status) {
      queryBuilder.andWhere('assignment.status = :status', { status });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('assignment.startDate BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      });
    } else if (startDate) {
      queryBuilder.andWhere('assignment.startDate >= :startDate', {
        startDate: new Date(startDate),
      });
    } else if (endDate) {
      queryBuilder.andWhere('assignment.endDate <= :endDate', {
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

  async findOne(organizationId: string, assignmentId: string): Promise<RentalAssignment> {
    const assignment = await this.rentalAssignmentRepository.findOne({
      where: { id: assignmentId, organizationId },
      relations: ['rentalHardware', 'event', 'invoice'],
    });

    if (!assignment) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Vermietungszuweisung nicht gefunden',
      });
    }

    return assignment;
  }

  async confirmAssignment(
    organizationId: string,
    assignmentId: string,
  ): Promise<RentalAssignment> {
    const assignment = await this.findOne(organizationId, assignmentId);

    if (assignment.status !== RentalAssignmentStatus.PENDING) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Zuweisung kann nur im Status "Ausstehend" bestätigt werden',
      });
    }

    assignment.status = RentalAssignmentStatus.CONFIRMED;
    assignment.confirmedAt = new Date();
    await this.rentalAssignmentRepository.save(assignment);

    this.logger.log(`Rental assignment confirmed: ${assignmentId}`);

    return assignment;
  }

  async declineAssignment(
    organizationId: string,
    assignmentId: string,
  ): Promise<RentalAssignment> {
    const assignment = await this.findOne(organizationId, assignmentId);

    if (assignment.status !== RentalAssignmentStatus.PENDING) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Zuweisung kann nur im Status "Ausstehend" abgelehnt werden',
      });
    }

    assignment.status = RentalAssignmentStatus.CANCELLED;
    await this.rentalAssignmentRepository.save(assignment);

    // Set hardware back to available
    await this.rentalHardwareRepository.update(
      { id: assignment.rentalHardwareId },
      { status: RentalHardwareStatus.AVAILABLE },
    );

    this.logger.log(`Rental assignment declined: ${assignmentId}`);

    return assignment;
  }

  async getActiveRentals(organizationId: string): Promise<RentalAssignment[]> {
    return this.rentalAssignmentRepository.find({
      where: {
        organizationId,
        status: RentalAssignmentStatus.ACTIVE,
      },
      relations: ['rentalHardware', 'event'],
      order: { startDate: 'ASC' },
    });
  }

  async getUpcomingRentals(organizationId: string): Promise<RentalAssignment[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return this.rentalAssignmentRepository
      .createQueryBuilder('assignment')
      .leftJoinAndSelect('assignment.rentalHardware', 'hardware')
      .leftJoinAndSelect('assignment.event', 'event')
      .where('assignment.organizationId = :organizationId', { organizationId })
      .andWhere('assignment.status IN (:...statuses)', {
        statuses: [RentalAssignmentStatus.PENDING, RentalAssignmentStatus.CONFIRMED],
      })
      .andWhere('assignment.startDate >= :today', { today })
      .orderBy('assignment.startDate', 'ASC')
      .getMany();
  }
}
