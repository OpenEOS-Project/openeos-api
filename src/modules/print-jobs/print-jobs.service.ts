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
import { LessThan, Repository } from 'typeorm';
import { PrintJob, Printer, PrintTemplate, User, UserOrganization } from '../../database/entities';
import { PrintJobStatus } from '../../database/entities/print-job.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { PaginatedResult, createPaginatedResult } from '../../common/dto/pagination.dto';
import { CreatePrintJobDto, QueryPrintJobsDto } from './dto';
import { GatewayService } from '../gateway/gateway.service';

/** Websocket payload a printer agent receives for one job. */
interface AgentJobEvent {
  jobId: string;
  printerId: string;
  templateName: string;
  copies: number;
  payload: Record<string, unknown>;
}

@Injectable()
export class PrintJobsService {
  private readonly logger = new Logger(PrintJobsService.name);
  private readonly MAX_RETRY_ATTEMPTS = 3;

  constructor(
    @InjectRepository(PrintJob)
    private readonly printJobRepository: Repository<PrintJob>,
    @InjectRepository(Printer)
    private readonly printerRepository: Repository<Printer>,
    @InjectRepository(PrintTemplate)
    private readonly printTemplateRepository: Repository<PrintTemplate>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
  ) {}

  async create(
    organizationId: string,
    createDto: CreatePrintJobDto,
    user: User,
  ): Promise<PrintJob> {
    await this.checkMembership(organizationId, user.id);

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

    // Resolve template name for the agent
    let templateName = 'receipt';
    if (createDto.templateId) {
      const template = await this.printTemplateRepository.findOne({
        where: { id: createDto.templateId, organizationId },
      });
      if (template) {
        templateName = template.type;
      }
    }

    // Send full print data to agent via WebSocket — targeted at the printer's
    // agent device. On ack the job moves to PRINTING; unacked jobs stay
    // QUEUED and are replayed when the agent (re)connects.
    this.dispatchJobToAgent(organizationId, printer.deviceId, {
      jobId: printJob.id,
      printerId: createDto.printerId,
      templateName,
      copies: createDto.payload?.copies as number || 1,
      payload: createDto.payload?.data as Record<string, unknown> || createDto.payload,
    });

    return printJob;
  }

  /**
   * Fire-and-forget delivery with ack handling: on ack the job transitions
   * QUEUED -> PRINTING, otherwise it stays QUEUED for replay-on-connect.
   */
  private dispatchJobToAgent(
    organizationId: string,
    agentDeviceId: string | null,
    event: AgentJobEvent,
  ): void {
    void this.gatewayService
      .sendPrintJobToAgent(organizationId, agentDeviceId, event)
      .then((acked) => {
        if (acked) {
          return this.markJobPrinting(event.jobId);
        }
        this.logger.warn(
          `Print job ${event.jobId} not acked by agent — stays queued for replay`,
        );
      })
      .catch((error) => {
        this.logger.error(
          `Print job ${event.jobId} delivery error: ${
            error instanceof Error ? error.message : error
          }`,
        );
      });
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
    await this.checkMembership(organizationId, user.id);

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

    // Resolve template name for the agent
    let templateName = 'receipt';
    if (job.templateId) {
      const template = await this.printTemplateRepository.findOne({
        where: { id: job.templateId, organizationId },
      });
      if (template) {
        templateName = template.type;
      }
    }

    // Resend to agent
    this.dispatchJobToAgent(organizationId, job.printer?.deviceId ?? null, {
      jobId: job.id,
      printerId: job.printerId,
      templateName,
      copies: job.payload?.copies as number || 1,
      payload: job.payload?.data as Record<string, unknown> || job.payload,
    });

    return job;
  }

  async cancel(organizationId: string, jobId: string, user: User): Promise<PrintJob> {
    await this.checkPermission(organizationId, user.id, 'devices');

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

  // Called by OrderPrintService (no user auth needed)
  async createFromWorkflow(
    organizationId: string,
    printerId: string,
    templateId: string | null,
    orderId: string | null,
    copies: number = 1,
    payload?: Record<string, unknown>,
    orderItemId?: string | null,
    /** Workflow-specific default template name when no `templateId` is given.
     *  Must match a built-in template file shipped with the printer agent
     *  (`kitchen_ticket`, `order_ticket`, `receipt`). Defaults to `receipt`
     *  for backwards compatibility. */
    defaultTemplateName: string = 'receipt',
  ): Promise<PrintJob> {
    const printer = await this.printerRepository.findOne({
      where: { id: printerId, organizationId },
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
      printerId,
      templateId: templateId || null,
      orderId: orderId || null,
      orderItemId: orderItemId || null,
      payload: { copies, data: payload || {} },
      status: PrintJobStatus.QUEUED,
      attempts: 0,
    });

    await this.printJobRepository.save(printJob);
    this.logger.log(`Print job created from auto-print: ${printJob.id} for printer ${printer.name}`);

    // Resolve template name for the agent. Falls back to the workflow-specific
    // default (kitchen_ticket / order_ticket / receipt) when no custom
    // templateId is provided — those names match the agent's built-in files.
    let templateName = defaultTemplateName;
    if (templateId) {
      const template = await this.printTemplateRepository.findOne({
        where: { id: templateId, organizationId },
      });
      if (template) {
        templateName = template.type;
      }
    }

    // Send to agent via WebSocket
    this.dispatchJobToAgent(organizationId, printer.deviceId, {
      jobId: printJob.id,
      printerId,
      templateName,
      copies,
      payload: payload || {},
    });

    return printJob;
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

  /**
   * Jobs to (re-)deliver to an agent device on connect: everything still
   * QUEUED plus PRINTING jobs that went stale (acked but no outcome reported
   * for 2+ minutes — e.g. the agent crashed mid-print). The agent dedupes by
   * jobId against its persistent queue, so re-delivery is safe.
   */
  async getQueuedJobsForDevice(deviceId: string): Promise<PrintJob[]> {
    const staleBefore = new Date(Date.now() - 2 * 60 * 1000);
    return this.printJobRepository.find({
      where: [
        { status: PrintJobStatus.QUEUED, printer: { deviceId } },
        {
          status: PrintJobStatus.PRINTING,
          printer: { deviceId },
          updatedAt: LessThan(staleBefore),
        },
      ],
      relations: ['template', 'printer'],
      order: { createdAt: 'ASC' },
      take: 50,
    });
  }

  /**
   * Transition a job to PRINTING after the agent acked receipt. Guarded so a
   * late ack can never regress a job that already completed or failed.
   */
  async markJobPrinting(jobId: string): Promise<void> {
    await this.printJobRepository.update(
      { id: jobId, status: PrintJobStatus.QUEUED },
      { status: PrintJobStatus.PRINTING },
    );
  }

  /** Build the websocket payload for an agent from a persisted job (same shape as create()). */
  buildAgentJobEvent(job: PrintJob): {
    jobId: string;
    printerId: string;
    templateName: string;
    copies: number;
    payload: Record<string, unknown>;
  } {
    return {
      jobId: job.id,
      printerId: job.printerId,
      templateName: job.template?.type || 'receipt',
      copies: (job.payload?.copies as number) || 1,
      payload: (job.payload?.data as Record<string, unknown>) || job.payload,
    };
  }

  /**
   * Update a job's status, optionally scoped to an organization (printer
   * agents may only touch jobs of their own org). Returns the job, or null
   * if it does not exist / belongs to another organization.
   */
  async updateJobStatus(
    jobId: string,
    status: PrintJobStatus,
    error?: string,
    organizationId?: string,
  ): Promise<PrintJob | null> {
    const job = await this.printJobRepository.findOne({
      where: organizationId ? { id: jobId, organizationId } : { id: jobId },
    });
    if (!job) {
      return null;
    }

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

    await this.printJobRepository.update({ id: job.id }, update);
    this.logger.log(`Print job ${jobId} status updated to ${status}`);
    return job;
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

    if (membership.role !== OrganizationRole.ADMIN && !membership.permissions?.[permission]) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }
  }
}
