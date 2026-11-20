import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  forwardRef,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  Device,
  Organization,
  PrintJob,
  Printer,
  ProductionStation,
  User,
  UserOrganization,
} from '../../database/entities';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { GatewayService } from '../gateway/gateway.service';
import { EventStatus } from '../../database/entities/event.entity';
import { Event } from '../../database/entities/event.entity';
import { EventPhaseService } from '../events/event-phase.service';
import type { EventPhase } from '../../common/utils/event-phase.util';

/**
 * Phases in which printing matters: real sales, test mode and the test
 * operation before the sales window opens.
 */
const RUNNING_PHASES: ReadonlySet<EventPhase> = new Set([
  'active',
  'test',
  'planned',
]);

/** A job counts as waiting once it is this old without an outcome. */
export const PRINT_HEALTH_WAITING_MS = 30_000;
/** Failed jobs within this window count as recent failures. */
export const PRINT_HEALTH_FAILED_WINDOW_MINUTES = 15;
/**
 * Open jobs older than this are no longer counted as waiting: nobody waits
 * for a kitchen ticket from yesterday, and the redelivery stops there too.
 */
export const PRINT_HEALTH_OPEN_MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** Error text of a job cancelled by hand — not a print failure. */
export const PRINT_JOB_CANCELLED_ERROR = 'Manuell abgebrochen';

export type PrintHealthStatus = 'ok' | 'warning' | 'error';
export type PrintHealthIssue =
  | 'agent_offline'
  | 'printer_offline'
  | 'jobs_waiting'
  | 'jobs_failed';

export interface PrintHealthPrinter {
  printerId: string;
  name: string;
  agentDeviceId: string | null;
  agentName: string | null;
  /** Agent socket connected (false without an agent). */
  agentOnline: boolean;
  /** Printer reachable according to the agent's heartbeat. */
  printerOnline: boolean;
  waitingJobs: number;
  oldestWaitingAt: string | null;
  failedJobs: number;
  issues: PrintHealthIssue[];
}

export interface PrintHealthAgent {
  deviceId: string;
  name: string;
  printerIds: string[];
}

/**
 * Print state of an organization (or of the printers one POS uses):
 *
 * - `error`: jobs wait longer than 30 s or failed in the last 15 minutes
 * - `warning`: an agent with printers is offline, or a printer is not
 *   reachable, but nothing is waiting
 * - `ok`: otherwise
 *
 * `printers` only lists printers with at least one issue.
 */
export interface PrintHealth {
  status: PrintHealthStatus;
  checkedAt: string;
  waitingJobs: number;
  failedJobs: number;
  oldestWaitingAt: string | null;
  offlineAgents: PrintHealthAgent[];
  printers: PrintHealthPrinter[];
  thresholds: { waitingSeconds: number; failedWindowMinutes: number };
  /**
   * An event of the organization is running (active, test mode or test
   * operation). Without one, an offline agent or printer alone is no
   * warning (`status: 'ok'`, `printers` still lists it); waiting or failed
   * jobs always are. `null` when it was not needed to decide.
   */
  eventRunning: boolean | null;
}

interface JobCountsRow {
  printer_id: string;
  waiting: string | number;
  oldest_waiting_at: Date | string | null;
  failed: string | number;
}

interface OrgCountsRow {
  organization_id: string;
  waiting: string | number;
  failed: string | number;
}

/** Parameters shared by the job count queries ($1..$4 in that order). */
function windowParams(now: Date): [Date, Date, Date, string] {
  return [
    new Date(now.getTime() - PRINT_HEALTH_WAITING_MS),
    new Date(now.getTime() - PRINT_HEALTH_OPEN_MAX_AGE_MS),
    new Date(now.getTime() - PRINT_HEALTH_FAILED_WINDOW_MINUTES * 60_000),
    PRINT_JOB_CANCELLED_ERROR,
  ];
}

const WAITING_SQL = `j.status IN ('queued', 'printing') AND j.created_at < $1 AND j.created_at > $2`;
const FAILED_SQL = `j.status = 'failed' AND j.updated_at > $3 AND COALESCE(j.error, '') <> $4`;

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * Print health per organization: which agents are offline, which jobs wait
 * or failed. Read by the admin (`GET …/print-jobs/health`), the POS
 * (`GET /device-api/status`) and pushed as a hint (`printHealthChanged`)
 * when the job counts of an organization change.
 */
@Injectable()
export class PrintHealthService {
  private readonly logger = new Logger(PrintHealthService.name);
  /** Last counts announced per organization (this instance). */
  private readonly published = new Map<string, string>();

  constructor(
    @InjectRepository(PrintJob)
    private readonly printJobRepository: Repository<PrintJob>,
    @InjectRepository(Printer)
    private readonly printerRepository: Repository<Printer>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(ProductionStation)
    private readonly stationRepository: Repository<ProductionStation>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
    @Optional()
    private readonly eventPhase?: EventPhaseService,
  ) {}

  /** Admin view: every active printer of the organization. */
  async forMember(organizationId: string, user: User): Promise<PrintHealth> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId: user.id },
    });
    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.ORGANIZATION_ACCESS_DENIED,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }
    return this.forOrganization(organizationId);
  }

  /**
   * Health of the organization's active printers, optionally limited to
   * `printerIds` (e.g. the printers one POS prints to).
   */
  async forOrganization(
    organizationId: string,
    options: { printerIds?: string[]; now?: Date } = {},
  ): Promise<PrintHealth> {
    const now = options.now ?? new Date();
    const printers = await this.printerRepository.find({
      where: {
        organizationId,
        isActive: true,
        ...(options.printerIds ? { id: In(options.printerIds) } : {}),
      },
      select: { id: true, name: true, deviceId: true, isOnline: true },
      order: { name: 'ASC' },
    });

    const empty: PrintHealth = {
      status: 'ok',
      checkedAt: now.toISOString(),
      waitingJobs: 0,
      failedJobs: 0,
      oldestWaitingAt: null,
      offlineAgents: [],
      printers: [],
      thresholds: {
        waitingSeconds: PRINT_HEALTH_WAITING_MS / 1000,
        failedWindowMinutes: PRINT_HEALTH_FAILED_WINDOW_MINUTES,
      },
      eventRunning: null,
    };
    if (printers.length === 0) return empty;

    const printerIds = printers.map((p) => p.id);
    const agentIds = [
      ...new Set(
        printers
          .map((p) => p.deviceId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];

    const [counts, onlineIds, agents] = await Promise.all([
      this.jobCounts(organizationId, printerIds, now),
      agentIds.length > 0
        ? this.gatewayService.getOnlineDeviceIds(organizationId)
        : Promise.resolve([] as string[]),
      agentIds.length > 0
        ? this.deviceRepository.find({
            where: { id: In(agentIds), organizationId },
            select: { id: true, name: true },
          })
        : Promise.resolve([] as Device[]),
    ]);
    const online = new Set(onlineIds);
    const agentNames = new Map(agents.map((a) => [a.id, a.name]));

    const health = empty;
    const offline = new Map<string, PrintHealthAgent>();
    let oldest: number | null = null;

    for (const printer of printers) {
      const row = counts.get(printer.id);
      const waiting = Number(row?.waiting ?? 0);
      const failed = Number(row?.failed ?? 0);
      const oldestWaitingAt =
        waiting > 0 ? toIso(row?.oldest_waiting_at ?? null) : null;
      const agentOnline = !!printer.deviceId && online.has(printer.deviceId);

      const issues: PrintHealthIssue[] = [];
      if (printer.deviceId && !agentOnline) issues.push('agent_offline');
      if (agentOnline && !printer.isOnline) issues.push('printer_offline');
      if (waiting > 0) issues.push('jobs_waiting');
      if (failed > 0) issues.push('jobs_failed');

      health.waitingJobs += waiting;
      health.failedJobs += failed;
      if (oldestWaitingAt) {
        const time = new Date(oldestWaitingAt).getTime();
        oldest = oldest === null ? time : Math.min(oldest, time);
      }

      if (printer.deviceId && !agentOnline) {
        const agent = offline.get(printer.deviceId) ?? {
          deviceId: printer.deviceId,
          name: agentNames.get(printer.deviceId) ?? '',
          printerIds: [],
        };
        agent.printerIds.push(printer.id);
        offline.set(printer.deviceId, agent);
      }

      if (issues.length > 0) {
        health.printers.push({
          printerId: printer.id,
          name: printer.name,
          agentDeviceId: printer.deviceId ?? null,
          agentName: printer.deviceId
            ? (agentNames.get(printer.deviceId) ?? null)
            : null,
          agentOnline,
          printerOnline: agentOnline && printer.isOnline,
          waitingJobs: waiting,
          oldestWaitingAt,
          failedJobs: failed,
          issues,
        });
      }
    }

    health.offlineAgents = [...offline.values()];
    health.oldestWaitingAt =
      oldest === null ? null : new Date(oldest).toISOString();
    if (health.waitingJobs > 0 || health.failedJobs > 0) {
      health.status = 'error';
    } else if (health.printers.length > 0) {
      // Offline only: between events that is normal (agent switched off).
      health.eventRunning = await this.isEventRunning(organizationId, now);
      health.status = health.eventRunning ? 'warning' : 'ok';
    } else {
      health.status = 'ok';
    }
    return health;
  }

  /**
   * Does the organization have an event in a phase where printing matters?
   * Only events with status active or test can be in one; their phase
   * (sales window, end) comes from EventPhaseService. Without it (hand-built
   * tests) the status alone decides.
   */
  private async isEventRunning(
    organizationId: string,
    now: Date,
  ): Promise<boolean> {
    const events = await this.printJobRepository.manager.find(Event, {
      where: {
        organizationId,
        status: In([EventStatus.ACTIVE, EventStatus.TEST]),
      },
    });
    if (events.length === 0) return false;
    if (!this.eventPhase) return true;
    const organization = await this.eventPhase.loadOrganization(organizationId);
    return events.some((event) =>
      RUNNING_PHASES.has(
        this.eventPhase!.resolveWith(event, organization, now).phase,
      ),
    );
  }

  /**
   * The printers a POS device prints to: its own default printer, the
   * organization's order-flow printers (kitchen, receipt, order ticket)
   * and the printers of the active production stations of its event.
   * The event must belong to the organization; otherwise its stations are
   * ignored.
   */
  async printerIdsForPosDevice(
    organizationId: string,
    device: Pick<Device, 'settings'>,
    eventId: string | null,
  ): Promise<string[]> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: { id: true, settings: true },
    });
    const orderFlow = organization?.settings?.orderFlow;
    const ids = new Set<string>();
    const add = (id: unknown) => {
      if (typeof id === 'string' && id) ids.add(id);
    };
    add(device.settings?.defaultPrinterId);
    add(orderFlow?.kitchenTicketPrinting?.printerId);
    add(orderFlow?.receiptPrinting?.printerId);
    add(orderFlow?.orderTicketPrinting?.printerId);

    if (eventId) {
      const stations = await this.stationRepository.find({
        where: { eventId, isActive: true, event: { organizationId } },
        select: { id: true, printerId: true },
      });
      for (const station of stations) add(station.printerId);
    }
    return [...ids];
  }

  /**
   * Announce changed job counts (`printHealthChanged`) for every
   * organization whose waiting/failed counts differ from the last
   * announcement — including the all-clear once they drop to zero. Called
   * by the redelivery cron, so "waiting longer than 30 s" shows up without
   * any client polling fast.
   *
   * The memory of what was announced lives in this instance; with several
   * instances an unchanged state may be announced once more, which only
   * costs a refetch.
   */
  async publishChanges(now: Date = new Date()): Promise<number> {
    const rows: OrgCountsRow[] = await this.printJobRepository.query(
      `SELECT j.organization_id,
              COUNT(*) FILTER (WHERE ${WAITING_SQL}) AS waiting,
              COUNT(*) FILTER (WHERE ${FAILED_SQL}) AS failed
         FROM print_jobs j
        WHERE (${WAITING_SQL}) OR (${FAILED_SQL})
        GROUP BY j.organization_id`,
      windowParams(now),
    );

    const current = new Map<string, { waiting: number; failed: number }>();
    for (const row of rows) {
      current.set(row.organization_id, {
        waiting: Number(row.waiting),
        failed: Number(row.failed),
      });
    }

    let sent = 0;
    const orgs = new Set([...current.keys(), ...this.published.keys()]);
    for (const organizationId of orgs) {
      const counts = current.get(organizationId) ?? { waiting: 0, failed: 0 };
      const signature = `${counts.waiting}:${counts.failed}`;
      const previous = this.published.get(organizationId);
      // Nothing announced yet and nothing to announce: stay quiet.
      if (previous === undefined && signature === '0:0') continue;
      if (previous === signature) continue;

      if (signature === '0:0') this.published.delete(organizationId);
      else this.published.set(organizationId, signature);

      this.gatewayService.notifyPrintHealthChanged({
        organizationId,
        waitingJobs: counts.waiting,
        failedJobs: counts.failed,
      });
      sent += 1;
    }
    if (sent > 0) {
      this.logger.debug(`Announced print health of ${sent} organization(s)`);
    }
    return sent;
  }

  private async jobCounts(
    organizationId: string,
    printerIds: string[],
    now: Date,
  ): Promise<Map<string, JobCountsRow>> {
    const rows: JobCountsRow[] = await this.printJobRepository.query(
      `SELECT j.printer_id,
              COUNT(*) FILTER (WHERE ${WAITING_SQL}) AS waiting,
              MIN(j.created_at) FILTER (WHERE ${WAITING_SQL}) AS oldest_waiting_at,
              COUNT(*) FILTER (WHERE ${FAILED_SQL}) AS failed
         FROM print_jobs j
        WHERE j.organization_id = $5
          AND j.printer_id = ANY($6::uuid[])
          AND ((${WAITING_SQL}) OR (${FAILED_SQL}))
        GROUP BY j.printer_id`,
      [...windowParams(now), organizationId, printerIds],
    );
    return new Map(rows.map((row) => [row.printer_id, row]));
  }
}
