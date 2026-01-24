import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PrintJob, Printer, User, UserOrganization } from '../../database/entities';
import { PrintJobStatus } from '../../database/entities/print-job.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { PaginatedResult, createPaginatedResult } from '../../common/dto/pagination.dto';
import { CreatePrintJobDto, QueryPrintJobsDto } from './dto';

@Injectable()
export class PrintJobsService {
  private readonly logger = new Logger(PrintJobsService.name);
  private readonly MAX_RETRY_ATTEMPTS = 3;

  constructor(
    @InjectRepository(PrintJob)
    private readonly printJobRepository: Repository<PrintJob>,
    @InjectRepository(Printer)
    private readonly printerRepository: Repository<Printer>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
  ) {}

  async create(
    organizationId: string,
    createDto: CreatePrintJobDto,
    user: User,
  ): Promise<PrintJob> {
    await this.checkRole(organizationId, user.id, OrganizationRole.CASHIER);

    // Verify printer exists and belongs to organization
    const printer = await this.printerRepository.findOne({
      where: { id: createDto.printerId, organizationId },
    });

    if (!printer) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Drucker nicht gefunden',
      });
    }

    if (!printer.isActive) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Drucker ist deaktiviert',
      });
    }

    const printJob = this.printJobRepository.create({
      organizationId,
      printerId: createDto.printerId,
      templateId: createDto.templateId || null,
      orderId: createDto.orderId || null,
      orderItemId: createDto.orderItemId || null,
      payload: createDto.payload,
      status: PrintJobStatus.QUEUED,
      attempts: 0,
    });

    await this.printJobRepository.save(printJob);
    this.logger.log(`Print job created: ${printJob.id} for printer ${printer.name}`);

    return printJob;
  }

  async findAll(
    organizationId: string,
    user: User,
    query: QueryPrintJobsDto,
  ): Promise<PaginatedResult<PrintJob>> {
    await this.checkMembership(organizationId, user.id);

    const { page = 1, limit = 50 } = query;
    const skip = (page - 1) * limit;

    const queryBuilder = this.printJobRepository
      .createQueryBuilder('job')
      .leftJoinAndSelect('job.printer', 'printer')
      .leftJoinAndSelect('job.template', 'template')
      .where('job.organizationId = :organizationId', { organizationId });

    if (query.printerId) {
      queryBuilder.andWhere('job.printerId = :printerId', { printerId: query.printerId });
    }

    if (query.orderId) {
      queryBuilder.andWhere('job.orderId = :orderId', { orderId: query.orderId });
    }

    if (query.status) {
      queryBuilder.andWhere('job.status = :status', { status: query.status });
    }

    queryBuilder
      .orderBy('job.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    const [items, total] = await queryBuilder.getManyAndCount();

    return createPaginatedResult(items, total, page, limit);
  }

  async findOne(organizationId: string, jobId: string, user: User): Promise<PrintJob> {
    await this.checkMembership(organizationId, user.id);

    const job = await this.printJobRepository.findOne({
      where: { id: jobId, organizationId },
      relations: ['printer', 'template', 'order', 'orderItem'],
    });

    if (!job) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Druckauftrag nicht gefunden',
      });
    }

    return job;
  }

  async retry(organizationId: string, jobId: string, user: User): Promise<PrintJob> {
    await this.checkRole(organizationId, user.id, OrganizationRole.CASHIER);

    const job = await this.findOne(organizationId, jobId, user);

    if (job.status !== PrintJobStatus.FAILED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Nur fehlgeschlagene Druckaufträge können wiederholt werden',
      });
    }

    if (job.attempts >= this.MAX_RETRY_ATTEMPTS) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Maximale Anzahl an Wiederholungen (${this.MAX_RETRY_ATTEMPTS}) erreicht`,
      });
    }

    job.status = PrintJobStatus.QUEUED;
    job.error = null;
    job.attempts += 1;
    await this.printJobRepository.save(job);

    this.logger.log(`Print job retry: ${job.id} (attempt ${job.attempts})`);

    return job;
  }

  async cancel(organizationId: string, jobId: string, user: User): Promise<PrintJob> {
    await this.checkRole(organizationId, user.id, OrganizationRole.MANAGER);

    const job = await this.findOne(organizationId, jobId, user);

    if (job.status === PrintJobStatus.COMPLETED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Abgeschlossene Druckaufträge können nicht abgebrochen werden',
      });
    }

    job.status = PrintJobStatus.FAILED;
    job.error = 'Manuell abgebrochen';
    await this.printJobRepository.save(job);

    this.logger.log(`Print job cancelled: ${job.id}`);

    return job;
  }

  // Methods for printer agents
  async getQueuedJobsForPrinter(printerId: string): Promise<PrintJob[]> {
    return this.printJobRepository.find({
      where: { printerId, status: PrintJobStatus.QUEUED },
      relations: ['template', 'order', 'orderItem'],
      order: { createdAt: 'ASC' },
      take: 10,
    });
  }

  async updateJobStatus(
    jobId: string,
    status: PrintJobStatus,
    error?: string,
  ): Promise<void> {
    const update: {
      status: PrintJobStatus;
      error?: string | null;
      printedAt?: Date;
    } = { status };

    if (error) {
      update.error = error;
    }

    if (status === PrintJobStatus.COMPLETED) {
      update.printedAt = new Date();
    }

    await this.printJobRepository.update({ id: jobId }, update);
    this.logger.log(`Print job ${jobId} status updated to ${status}`);
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
