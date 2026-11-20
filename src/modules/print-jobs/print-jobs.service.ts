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
import { In, LessThan, MoreThan, Repository } from 'typeorm';
import {
  PrintJob,
  Printer,
  PrintTemplate,
  User,
  UserOrganization,
} from '../../database/entities';
import { PrintJobStatus } from '../../database/entities/print-job.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  PaginatedResult,
  createPaginatedResult,
} from '../../common/dto/pagination.dto';
import { CreatePrintJobDto, QueryPrintJobsDto } from './dto';
import { assertReferencesInOrganization } from '../../common/utils/organization-references';
import {
  OPERATING_MODE_SELECT,
  isOrdersOnly,
} from '../../common/utils/operating-mode.util';
import { Organization } from '../../database/entities/organization.entity';
import { GatewayService } from '../gateway/gateway.service';
import { agentTemplateMap } from './builtin-templates';
import { PRINT_JOB_CANCELLED_ERROR } from './print-health.service';

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
        reason: ErrorReasons.PRINTER_NOT_FOUND,
        message: 'Drucker nicht gefunden',
      });
    }

    if (!printer.isActive) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.PRINTER_INACTIVE,
        message: 'Drucker ist deaktiviert',
      });
    }

    // Vorlage, Bestellung und Position aus derselben Organisation (die
    // Position zudem aus der angegebenen Bestellung).
    await assertReferencesInOrganization(
      this.printJobRepository.manager,
      { organizationId, orderId: createDto.orderId || null },
      [
        {
          kind: 'printTemplate',
          ids: createDto.templateId,
          field: 'templateId',
        },
        { kind: 'order', ids: createDto.orderId, field: 'orderId' },
        { kind: 'orderItem', ids: createDto.orderItemId, field: 'orderItemId' },
      ],
    );

    const templateName = await this.resolveTemplateName(
      organizationId,
      createDto.templateId || null,
    );

    const printJob = this.printJobRepository.create({
      organizationId,
      printerId: createDto.printerId,
      templateId: createDto.templateId || null,
      orderId: createDto.orderId || null,
      orderItemId: createDto.orderItemId || null,
      payload: { ...createDto.payload, templateName },
      status: PrintJobStatus.QUEUED,
      attempts: 0,
    });

    await this.printJobRepository.save(printJob);
    this.logger.log(
      `Print job created: ${printJob.id} for printer ${printer.name}`,
    );

    // Send full print data to agent via WebSocket — targeted at the printer's
    // agent device. On ack the job moves to PRINTING; unacked jobs stay
    // QUEUED and are replayed when the agent (re)connects and by the
    // periodic redelivery (PrintJobRedeliveryService).
    this.dispatchJobToAgent(
      organizationId,
      printer.deviceId,
      this.buildAgentJobEvent(printJob),
    );

    return printJob;
  }

  /**
   * Resolve the template name the agent should render with. A custom template
   * wins; otherwise the workflow-specific default (`kitchen_ticket`,
   * `order_ticket`, `receipt`) is used — those names match the agent's
   * built-in template files. Resolved once at creation and persisted on the
   * job so that every later (re-)delivery uses the identical name.
   */
  private async resolveTemplateName(
    organizationId: string,
    templateId: string | null,
    fallback: string = 'receipt',
  ): Promise<string> {
    if (!templateId) {
      return fallback;
    }
    const template = await this.printTemplateRepository.findOne({
      where: { id: templateId, organizationId },
    });
    return template?.type || fallback;
  }

  /**
   * Fire-and-forget delivery with ack handling: on ack the job transitions
   * QUEUED -> PRINTING, otherwise it stays QUEUED for replay-on-connect and
   * the periodic redelivery.
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
      queryBuilder.andWhere('job.printerId = :printerId', {
        printerId: query.printerId,
      });
    }

    if (query.orderId) {
      queryBuilder.andWhere('job.orderId = :orderId', {
        orderId: query.orderId,
      });
    }

    if (query.status) {
      queryBuilder.andWhere('job.status = :status', { status: query.status });
    }

    queryBuilder.orderBy('job.createdAt', 'DESC').skip(skip).take(limit);

    const [items, total] = await queryBuilder.getManyAndCount();

    return createPaginatedResult(items, total, page, limit);
  }

  async findOne(
    organizationId: string,
    jobId: string,
    user: User,
  ): Promise<PrintJob> {
    await this.checkMembership(organizationId, user.id);

    const job = await this.printJobRepository.findOne({
      where: { id: jobId, organizationId },
      relations: ['printer', 'template', 'order', 'orderItem'],
    });

    if (!job) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.PRINT_JOB_NOT_FOUND,
        message: 'Druckauftrag nicht gefunden',
      });
    }

    return job;
  }

  async retry(
    organizationId: string,
    jobId: string,
    user: User,
  ): Promise<PrintJob> {
    await this.checkMembership(organizationId, user.id);

    const job = await this.findOne(organizationId, jobId, user);

    if (job.status !== PrintJobStatus.FAILED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.PRINT_JOB_NOT_FAILED,
        message: 'Nur fehlgeschlagene Druckaufträge können wiederholt werden',
      });
    }

    if ((job.retryCount ?? 0) >= this.MAX_RETRY_ATTEMPTS) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.PRINT_JOB_RETRY_LIMIT,
        message: `Maximale Anzahl an Wiederholungen (${this.MAX_RETRY_ATTEMPTS}) erreicht`,
        params: { max: this.MAX_RETRY_ATTEMPTS },
      });
    }

    job.status = PrintJobStatus.QUEUED;
    job.error = null;
    // `attempts` is what the agent reports; manual retries count separately.
    job.retryCount = (job.retryCount ?? 0) + 1;
    await this.printJobRepository.save(job);

    this.logger.log(`Print job retry: ${job.id} (retry ${job.retryCount})`);

    // Resend to agent — same payload as the original dispatch
    this.dispatchJobToAgent(
      organizationId,
      job.printer?.deviceId ?? null,
      this.buildAgentJobEvent(job),
    );

    return job;
  }

  async cancel(
    organizationId: string,
    jobId: string,
    user: User,
  ): Promise<PrintJob> {
    await this.checkPermission(organizationId, user.id, 'devices');

    const job = await this.findOne(organizationId, jobId, user);

    if (job.status === PrintJobStatus.COMPLETED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.PRINT_JOB_COMPLETED,
        message: 'Abgeschlossene Druckaufträge können nicht abgebrochen werden',
      });
    }

    job.status = PrintJobStatus.FAILED;
    job.error = PRINT_JOB_CANCELLED_ERROR;
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
        reason: ErrorReasons.PRINTER_NOT_FOUND,
        message: 'Drucker nicht gefunden',
      });
    }

    if (!printer.isActive) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.PRINTER_INACTIVE,
        message: 'Drucker ist deaktiviert',
      });
    }

    // Betriebsart „Nur Bons“ (orders_only): keine Preise auf Bons.
    // `hide_prices` geht an jede Vorlage; die mitgelieferten Vorlagen
    // (builtin-templates.ts) lassen damit alle Betraege weg.
    const organization = await this.printerRepository.manager.findOne(
      Organization,
      { where: { id: organizationId }, select: OPERATING_MODE_SELECT },
    );
    const hidePrices = isOrdersOnly(organization);

    const templateName = await this.resolveTemplateName(
      organizationId,
      templateId || null,
      defaultTemplateName,
    );

    const printJob = this.printJobRepository.create({
      organizationId,
      printerId,
      templateId: templateId || null,
      orderId: orderId || null,
      orderItemId: orderItemId || null,
      payload: {
        copies,
        templateName,
        data: { ...(payload || {}), hide_prices: hidePrices },
      },
      status: PrintJobStatus.QUEUED,
      attempts: 0,
    });

    await this.printJobRepository.save(printJob);
    this.logger.log(
      `Print job created from auto-print: ${printJob.id} for printer ${printer.name}`,
    );

    // Send to agent via WebSocket
    this.dispatchJobToAgent(
      organizationId,
      printer.deviceId,
      this.buildAgentJobEvent(printJob),
    );

    return printJob;
  }

  /** Vorlagen fuer die Agenten einer Organisation (siehe agentTemplateMap). */
  async agentTemplates(
    organizationId: string,
  ): Promise<Record<string, string>> {
    const templates = await this.printTemplateRepository.find({
      where: { organizationId },
    });
    return agentTemplateMap(templates);
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
   * jobId against its persistent queue while it still holds the job.
   *
   * This replay runs for every agent, old or new. While an agent stays
   * connected, PRINTING jobs are only sent again to agents announcing
   * `idempotentJobs` (see PrintJobRedeliveryService).
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

  /**
   * Build the websocket payload for an agent from a persisted job. Used for
   * the initial dispatch, manual retries and replay on agent reconnect alike,
   * so all three send the identical event.
   *
   * The template name persisted at creation wins. Jobs created before it was
   * persisted fall back to the loaded custom template, then to `receipt`.
   */
  buildAgentJobEvent(job: PrintJob): AgentJobEvent {
    return {
      jobId: job.id,
      printerId: job.printerId,
      templateName:
        job.payload?.templateName || job.template?.type || 'receipt',
      copies: job.payload?.copies || 1,
      payload: job.payload?.data || job.payload,
    };
  }

  /**
   * Jobs the periodic redelivery hands to connected agents: still QUEUED
   * (never acked), on a printer of one of the given agent devices, untouched
   * for `idleMs` (so an initial dispatch still waiting for its ack is not
   * sent twice) and not older than `maxAgeMs`.
   */
  async findQueuedJobsForRedelivery(
    deviceIds: string[],
    now: Date,
    idleMs: number,
    maxAgeMs: number,
    limit: number,
  ): Promise<PrintJob[]> {
    if (deviceIds.length === 0) return [];
    return this.printJobRepository.find({
      where: {
        status: PrintJobStatus.QUEUED,
        printer: { deviceId: In(deviceIds) },
        updatedAt: LessThan(new Date(now.getTime() - idleMs)),
        createdAt: MoreThan(new Date(now.getTime() - maxAgeMs)),
      },
      relations: ['template', 'printer'],
      order: { createdAt: 'ASC' },
      take: limit,
    });
  }

  /**
   * PRINTING jobs without an outcome for `staleMs` on printers of the given
   * agent devices go back to QUEUED, so the redelivery sends them again.
   * Only for agents that dedupe by job id (`capabilities.idempotentJobs`):
   * for them a second delivery of a printed job re-reports the outcome
   * instead of printing twice. Jobs older than `maxAgeMs` are left alone —
   * the agent's dedupe window is limited (about 24 h).
   *
   * The update is guarded by status and `updated_at`, so a report that
   * lands in between wins. Returns the ids that were re-queued.
   */
  async requeueStalePrintingJobs(
    deviceIds: string[],
    now: Date,
    staleMs: number,
    maxAgeMs: number,
  ): Promise<string[]> {
    if (deviceIds.length === 0) return [];
    const result = await this.printJobRepository
      .createQueryBuilder()
      .update(PrintJob)
      .set({ status: PrintJobStatus.QUEUED })
      .where('status = :printing', { printing: PrintJobStatus.PRINTING })
      .andWhere('updated_at < :staleBefore', {
        staleBefore: new Date(now.getTime() - staleMs),
      })
      .andWhere('created_at > :notBefore', {
        notBefore: new Date(now.getTime() - maxAgeMs),
      })
      .andWhere(
        'printer_id IN (SELECT p.id FROM printers p WHERE p.device_id IN (:...deviceIds))',
        { deviceIds },
      )
      .returning(['id'])
      .execute();
    const rows = (result.raw ?? []) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  async findJobsWithPrinter(ids: string[]): Promise<PrintJob[]> {
    if (ids.length === 0) return [];
    return this.printJobRepository.find({
      where: { id: In(ids) },
      relations: ['template', 'printer'],
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Store the outcome an agent reported for a job (scoped to the agent's
   * organization). Returns null for unknown/foreign jobs.
   *
   * Reports are idempotent: agents that dedupe by job id resend a report
   * until it is acked and answer a redelivered, already printed job with
   * its outcome again. A repeated completion therefore changes nothing
   * (`changed: false`, the first `printedAt` stays), and a failure never
   * overwrites a completion. A completion after a failure (e.g. printed on
   * a later attempt) wins.
   *
   * `attempts` / `printedAt` come from newer agents; without them the
   * old behaviour applies (`printedAt` = now, `attempts` untouched).
   */
  async updateJobStatus(
    jobId: string,
    status: PrintJobStatus.COMPLETED | PrintJobStatus.FAILED,
    error?: string,
    organizationId?: string,
    report: AgentJobReport = {},
  ): Promise<{ job: PrintJob; changed: boolean } | null> {
    const job = await this.printJobRepository.findOne({
      where: organizationId ? { id: jobId, organizationId } : { id: jobId },
    });
    if (!job) {
      return null;
    }

    if (job.status === PrintJobStatus.COMPLETED) {
      if (status !== PrintJobStatus.COMPLETED) {
        this.logger.warn(
          `Print job ${jobId} is completed — late failure report ignored`,
        );
      }
      return { job, changed: false };
    }

    const update: {
      status: PrintJobStatus;
      error?: string | null;
      printedAt?: Date;
      attempts?: number;
    } = { status };

    if (status === PrintJobStatus.COMPLETED) {
      update.error = null;
      update.printedAt = sanitizePrintedAt(report.printedAt, job.createdAt);
    } else if (error) {
      update.error = error;
    }

    const attempts = sanitizeAttempts(report.attempts);
    if (attempts !== null) {
      update.attempts = attempts;
    }

    await this.printJobRepository.update({ id: job.id }, update);
    Object.assign(job, update);
    this.logger.log(
      `Print job ${jobId} status updated to ${status}${
        attempts !== null ? ` (${attempts} attempt(s))` : ''
      }`,
    );
    return { job, changed: true };
  }

  private async checkMembership(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.ORGANIZATION_ACCESS_DENIED,
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
        reason: ErrorReasons.ORGANIZATION_ACCESS_DENIED,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }

    if (
      membership.role !== OrganizationRole.ADMIN &&
      !membership.permissions?.[permission]
    ) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }
  }
}

/** Optional extras an agent sends with a job report. */
export interface AgentJobReport {
  attempts?: unknown;
  printedAt?: unknown;
}

/** Highest attempt count accepted from an agent (guards the int column). */
const MAX_REPORTED_ATTEMPTS = 1000;

/** Positive integer attempt count, or null if absent/invalid. */
export function sanitizeAttempts(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const attempts = Math.trunc(value);
  if (attempts < 0) return null;
  return Math.min(attempts, MAX_REPORTED_ATTEMPTS);
}

/** Allowed clock skew between agent and server for `printedAt`. */
const PRINTED_AT_SKEW_MS = 5 * 60 * 1000;

/**
 * The agent's print time if it is plausible: a valid date, not in the
 * future (beyond clock skew) and not before the job existed (minus skew).
 * Otherwise the time the report arrived.
 */
export function sanitizePrintedAt(
  value: unknown,
  createdAt: Date | null | undefined,
  now: Date = new Date(),
): Date {
  if (typeof value !== 'string' || !value) return now;
  const printedAt = new Date(value);
  const time = printedAt.getTime();
  if (Number.isNaN(time)) return now;
  if (time > now.getTime() + PRINTED_AT_SKEW_MS) return now;
  if (createdAt && time < createdAt.getTime() - PRINTED_AT_SKEW_MS) return now;
  return printedAt;
}
