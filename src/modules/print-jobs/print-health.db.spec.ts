import { INVALID_WHERE_VALUES_BEHAVIOR } from '../../config/where-values';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import {
  Device,
  Organization,
  PrintJob,
  PrintTemplate,
  Printer,
  ProductionStation,
  UserOrganization,
} from '../../database/entities';
import { PrintJobStatus } from '../../database/entities/print-job.entity';
import { GatewayService } from '../gateway/gateway.service';
import { PrintJobsService } from './print-jobs.service';
import {
  PRINT_JOB_CANCELLED_ERROR,
  PrintHealthService,
} from './print-health.service';
import {
  PrintJobRedeliveryService,
  REDELIVERY_IDLE_MS,
  REDELIVERY_MAX_AGE_MS,
  REDELIVERY_STALE_PRINTING_MS,
} from './print-job-redelivery.service';

/**
 * Redelivery queries and print health against a real Postgres (migration,
 * guarded re-queue, count windows).
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:5546/openeos_print_scratch pnpm test
 *
 * Name muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

const MINUTE = 60_000;

describeWithDb('Print job redelivery and health against Postgres', () => {
  let ds: DataSource;
  const orgIds: string[] = [];
  let online: string[] = [];
  const gateway = {
    getOnlineDeviceIds: jest.fn(() => Promise.resolve(online)),
    getConnectedPrinterAgents: jest.fn(),
    sendPrintJobToAgent: jest.fn(() => Promise.resolve(true)),
    notifyPrintHealthChanged: jest.fn(),
  };
  let jobs: PrintJobsService;
  let health: PrintHealthService;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name)) {
      throw new Error(`Database "${name}" does not end in _test/_scratch`);
    }
    ds = new DataSource({
      invalidWhereValuesBehavior: INVALID_WHERE_VALUES_BEHAVIOR,
      type: 'postgres',
      url: TEST_DB,
      entities: [path.join(__dirname, '../../database/entities/*.entity.ts')],
      migrations: [path.join(__dirname, '../../database/migrations/*.ts')],
      migrationsRun: true,
      logging: false,
    });
    await ds.initialize();
    jobs = new PrintJobsService(
      ds.getRepository(PrintJob),
      ds.getRepository(Printer),
      ds.getRepository(PrintTemplate),
      ds.getRepository(UserOrganization),
      gateway as unknown as GatewayService,
    );
    health = new PrintHealthService(
      ds.getRepository(PrintJob),
      ds.getRepository(Printer),
      ds.getRepository(Device),
      ds.getRepository(ProductionStation),
      ds.getRepository(Organization),
      ds.getRepository(UserOrganization),
      gateway as unknown as GatewayService,
    );
  }, 120_000);

  afterAll(async () => {
    if (ds?.isInitialized) {
      if (orgIds.length) {
        await ds.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
          orgIds,
        ]);
      }
      await ds.destroy();
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    online = [];
  });

  async function q<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return await ds.query(sql, params);
  }

  async function world() {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await q(
      `INSERT INTO organizations (id, name, slug, support_pin, settings)
       VALUES ($1, 'Verein', $2, '123456', '{}')`,
      [orgId, `verein-${orgId}`],
    );
    const agent = async (name: string) =>
      (
        await q<{ id: string }>(
          `INSERT INTO devices (organization_id, name, type, status, device_token, settings)
           VALUES ($1, $2, 'printer_agent', 'verified', $3, '{}') RETURNING id`,
          [orgId, name, `tok-${randomUUID()}`],
        )
      )[0].id;
    const printer = async (
      name: string,
      deviceId: string | null,
      extra: { isOnline?: boolean; isActive?: boolean } = {},
    ) =>
      (
        await q<{ id: string }>(
          `INSERT INTO printers (organization_id, device_id, name, type, connection_type, is_online, is_active)
           VALUES ($1, $2, $3, 'receipt', 'network', $4, $5) RETURNING id`,
          [
            orgId,
            deviceId,
            name,
            extra.isOnline ?? true,
            extra.isActive ?? true,
          ],
        )
      )[0].id;
    return { orgId, agent, printer };
  }

  async function addJob(
    orgId: string,
    printerId: string,
    status: PrintJobStatus,
    ageMs: number,
    extra: { updatedAgoMs?: number; error?: string } = {},
  ): Promise<string> {
    const now = Date.now();
    const [row] = await q<{ id: string }>(
      `INSERT INTO print_jobs (organization_id, printer_id, status, payload, error, created_at, updated_at)
       VALUES ($1, $2, $3, '{"type":"kitchen","templateName":"kitchen_ticket","data":{}}', $4, $5, $6)
       RETURNING id`,
      [
        orgId,
        printerId,
        status,
        extra.error ?? null,
        new Date(now - ageMs),
        new Date(now - (extra.updatedAgoMs ?? ageMs)),
      ],
    );
    return row.id;
  }

  const statusOf = async (id: string) =>
    (
      await q<{ status: string }>(
        `SELECT status FROM print_jobs WHERE id = $1`,
        [id],
      )
    )[0].status;

  it('migration added retry_count and the open-jobs index', async () => {
    const [column] = await q<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'print_jobs' AND column_name = 'retry_count'`,
    );
    expect(column.column_default).toBe('0');
    const indexes = await q<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'print_jobs' AND indexname = 'IDX_print_jobs_open'`,
    );
    expect(indexes).toHaveLength(1);
  });

  describe('requeueStalePrintingJobs', () => {
    it('re-queues only stale, not too old printing jobs of the given agents', async () => {
      const w = await world();
      const capable = await w.agent('neu');
      const legacy = await w.agent('alt');
      const pCapable = await w.printer('Küche', capable);
      const pLegacy = await w.printer('Theke', legacy);
      const stale = REDELIVERY_STALE_PRINTING_MS + MINUTE;

      const staleJob = await addJob(
        w.orgId,
        pCapable,
        PrintJobStatus.PRINTING,
        stale,
      );
      const fresh = await addJob(
        w.orgId,
        pCapable,
        PrintJobStatus.PRINTING,
        30_000,
      );
      const ancient = await addJob(
        w.orgId,
        pCapable,
        PrintJobStatus.PRINTING,
        REDELIVERY_MAX_AGE_MS + MINUTE,
      );
      const done = await addJob(
        w.orgId,
        pCapable,
        PrintJobStatus.COMPLETED,
        stale,
      );
      const legacyJob = await addJob(
        w.orgId,
        pLegacy,
        PrintJobStatus.PRINTING,
        stale,
      );

      const ids = await jobs.requeueStalePrintingJobs(
        [capable],
        new Date(),
        REDELIVERY_STALE_PRINTING_MS,
        REDELIVERY_MAX_AGE_MS,
      );

      expect(ids).toEqual([staleJob]);
      expect(await statusOf(staleJob)).toBe('queued');
      for (const id of [fresh, ancient, legacyJob]) {
        expect(await statusOf(id)).toBe('printing');
      }
      expect(await statusOf(done)).toBe('completed');
      // updated_at moved, so the next run does not pick it up again.
      const again = await jobs.requeueStalePrintingJobs(
        [capable],
        new Date(),
        REDELIVERY_STALE_PRINTING_MS,
        REDELIVERY_MAX_AGE_MS,
      );
      expect(again).toEqual([]);
    });

    it('does nothing without idempotent agents', async () => {
      await expect(
        jobs.requeueStalePrintingJobs([], new Date(), 1, REDELIVERY_MAX_AGE_MS),
      ).resolves.toEqual([]);
    });
  });

  describe('markJobPrinting', () => {
    it('restarts the stale timer of a printing job, never touches finished ones', async () => {
      const w = await world();
      const agent = await w.agent('Pi');
      const p = await w.printer('Küche', agent);
      const old = 10 * MINUTE;
      const queued = await addJob(w.orgId, p, PrintJobStatus.QUEUED, old);
      const printing = await addJob(w.orgId, p, PrintJobStatus.PRINTING, old);
      const done = await addJob(w.orgId, p, PrintJobStatus.COMPLETED, old);
      const failed = await addJob(w.orgId, p, PrintJobStatus.FAILED, old);

      for (const id of [queued, printing, done, failed]) {
        await jobs.markJobPrinting(id);
      }

      const rows = await q<{ id: string; status: string; fresh: boolean }>(
        `SELECT id, status, updated_at > now() - interval '1 minute' AS fresh
           FROM print_jobs WHERE id = ANY($1::uuid[])`,
        [[queued, printing, done, failed]],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(queued)).toMatchObject({
        status: 'printing',
        fresh: true,
      });
      expect(byId.get(printing)).toMatchObject({
        status: 'printing',
        fresh: true,
      });
      expect(byId.get(done)).toMatchObject({
        status: 'completed',
        fresh: false,
      });
      expect(byId.get(failed)).toMatchObject({
        status: 'failed',
        fresh: false,
      });
    });
  });

  describe('findQueuedJobsForRedelivery', () => {
    it('returns idle queued jobs of the agents, oldest first, with printer', async () => {
      const w = await world();
      const agent = await w.agent('Pi');
      const other = await w.agent('Anderer');
      const p = await w.printer('Küche', agent);
      const pOther = await w.printer('Bar', other);

      const older = await addJob(w.orgId, p, PrintJobStatus.QUEUED, 5 * MINUTE);
      const newer = await addJob(w.orgId, p, PrintJobStatus.QUEUED, 2 * MINUTE);
      // Just dispatched — its ack may still be on the way.
      await addJob(w.orgId, p, PrintJobStatus.QUEUED, 5_000);
      await addJob(
        w.orgId,
        p,
        PrintJobStatus.QUEUED,
        REDELIVERY_MAX_AGE_MS + MINUTE,
      );
      await addJob(w.orgId, p, PrintJobStatus.PRINTING, 5 * MINUTE);
      await addJob(w.orgId, pOther, PrintJobStatus.QUEUED, 5 * MINUTE);

      const found = await jobs.findQueuedJobsForRedelivery(
        [agent],
        new Date(),
        REDELIVERY_IDLE_MS,
        REDELIVERY_MAX_AGE_MS,
        50,
      );
      expect(found.map((j) => j.id)).toEqual([older, newer]);
      expect(found[0].printer.deviceId).toBe(agent);
    });
  });

  describe('PrintJobRedeliveryService end to end', () => {
    it("resends to the idempotent agent, keeps the legacy agent's printing job", async () => {
      const w = await world();
      const capable = await w.agent('neu');
      const legacy = await w.agent('alt');
      const pCapable = await w.printer('Küche', capable);
      const pLegacy = await w.printer('Theke', legacy);
      const stale = REDELIVERY_STALE_PRINTING_MS + MINUTE;
      const capableStale = await addJob(
        w.orgId,
        pCapable,
        PrintJobStatus.PRINTING,
        stale,
      );
      const legacyStale = await addJob(
        w.orgId,
        pLegacy,
        PrintJobStatus.PRINTING,
        stale,
      );
      const legacyQueued = await addJob(
        w.orgId,
        pLegacy,
        PrintJobStatus.QUEUED,
        MINUTE,
      );

      gateway.getConnectedPrinterAgents.mockResolvedValue([
        { deviceId: capable, organizationId: w.orgId, idempotentJobs: true },
        { deviceId: legacy, organizationId: w.orgId, idempotentJobs: false },
      ]);
      const redelivery = new PrintJobRedeliveryService(
        jobs,
        gateway as unknown as GatewayService,
        { runExclusive: jest.fn() } as never,
        health,
      );
      const result = await redelivery.run(new Date());

      const sent = (gateway.sendPrintJobToAgent.mock.calls as unknown[][]).map(
        (c) => [c[1], (c[2] as { jobId: string }).jobId],
      );
      expect(sent).toEqual(
        expect.arrayContaining([
          [capable, capableStale],
          [legacy, legacyQueued],
        ]),
      );
      expect(sent).not.toContainEqual([legacy, legacyStale]);
      expect(result).toMatchObject({ requeued: 1, acked: sent.length });
      expect(await statusOf(capableStale)).toBe('printing');
      expect(await statusOf(legacyQueued)).toBe('printing');
      expect(await statusOf(legacyStale)).toBe('printing');
    });
  });

  describe('PrintHealthService', () => {
    it('reports offline agents, waiting and failed jobs per printer', async () => {
      const w = await world();
      const kitchenAgent = await w.agent('Pi Küche');
      const barAgent = await w.agent('Pi Bar');
      const kitchen = await w.printer('Küche', kitchenAgent);
      const bar = await w.printer('Bar', barAgent, { isOnline: false });
      const fine = await w.printer('Theke', barAgent);
      await w.printer('Alt', kitchenAgent, { isActive: false });
      online = [barAgent];

      await addJob(w.orgId, kitchen, PrintJobStatus.QUEUED, 2 * MINUTE);
      await addJob(w.orgId, kitchen, PrintJobStatus.PRINTING, 5 * MINUTE);
      await addJob(w.orgId, kitchen, PrintJobStatus.QUEUED, 5_000); // too fresh
      await addJob(w.orgId, kitchen, PrintJobStatus.QUEUED, 13 * 60 * MINUTE); // too old
      await addJob(w.orgId, bar, PrintJobStatus.FAILED, 3 * MINUTE, {
        error: 'PRINTER_OFFLINE: Papier',
      });
      await addJob(w.orgId, bar, PrintJobStatus.FAILED, 3 * MINUTE, {
        error: PRINT_JOB_CANCELLED_ERROR,
      });
      await addJob(w.orgId, bar, PrintJobStatus.FAILED, 60 * MINUTE, {
        error: 'old failure',
      });
      await addJob(w.orgId, fine, PrintJobStatus.COMPLETED, MINUTE);

      const result = await health.forOrganization(w.orgId);

      expect(result.status).toBe('error');
      expect(result.waitingJobs).toBe(2);
      expect(result.failedJobs).toBe(1);
      expect(result.offlineAgents).toEqual([
        { deviceId: kitchenAgent, name: 'Pi Küche', printerIds: [kitchen] },
      ]);
      const byName = Object.fromEntries(
        result.printers.map((p) => [p.name, p]),
      );
      expect(Object.keys(byName).sort()).toEqual(['Bar', 'Küche']);
      expect(byName['Küche']).toMatchObject({
        agentOnline: false,
        waitingJobs: 2,
        issues: ['agent_offline', 'jobs_waiting'],
      });
      expect(new Date(byName['Küche'].oldestWaitingAt!).getTime()).toBeLessThan(
        Date.now() - 4 * MINUTE,
      );
      expect(byName['Bar']).toMatchObject({
        agentOnline: true,
        printerOnline: false,
        failedJobs: 1,
        issues: ['printer_offline', 'jobs_failed'],
      });
    });

    it('limits to given printers, warns on offline-only, ok when all is well', async () => {
      const w = await world();
      const agent = await w.agent('Pi');
      const a = await w.printer('A', agent);
      const b = await w.printer('B', agent);
      await addJob(w.orgId, b, PrintJobStatus.QUEUED, 2 * MINUTE);

      const offline = await health.forOrganization(w.orgId, {
        printerIds: [a],
      });
      expect(offline).toMatchObject({ status: 'warning', waitingJobs: 0 });

      online = [agent];
      await expect(
        health.forOrganization(w.orgId, { printerIds: [a] }),
      ).resolves.toMatchObject({ status: 'ok', printers: [] });
      await expect(health.forOrganization(w.orgId)).resolves.toMatchObject({
        status: 'error',
        waitingJobs: 1,
      });
    });

    it('collects the printers a POS prints to', async () => {
      const w = await world();
      const agent = await w.agent('Pi');
      const own = await w.printer('Eigener', agent);
      const kitchen = await w.printer('Küche', agent);
      const grill = await w.printer('Grill', agent);
      const otherEvent = await w.printer('Anderes Fest', agent);
      await q(`UPDATE organizations SET settings = $2 WHERE id = $1`, [
        w.orgId,
        { orderFlow: { kitchenTicketPrinting: { printerId: kitchen } } },
      ]);
      const [event] = await q<{ id: string }>(
        `INSERT INTO events (organization_id, name, status) VALUES ($1, 'Fest', 'active') RETURNING id`,
        [w.orgId],
      );
      const [other] = await q<{ id: string }>(
        `INSERT INTO events (organization_id, name, status) VALUES ($1, 'Anderes', 'inactive') RETURNING id`,
        [w.orgId],
      );
      await q(
        `INSERT INTO production_stations (event_id, name, printer_id) VALUES ($1, 'Grill', $2), ($3, 'X', $4)`,
        [event.id, grill, other.id, otherEvent],
      );
      await q(
        `INSERT INTO production_stations (event_id, name, printer_id, is_active) VALUES ($1, 'Aus', $2, false)`,
        [event.id, otherEvent],
      );

      const ids = await health.printerIdsForPosDevice(
        w.orgId,
        { settings: { defaultPrinterId: own } } as never,
        event.id,
      );
      expect(ids.sort()).toEqual([own, kitchen, grill].sort());

      // An event of another organization contributes nothing.
      const foreign = await world();
      const leaked = await health.printerIdsForPosDevice(
        foreign.orgId,
        { settings: {} } as never,
        event.id,
      );
      expect(leaked).toEqual([]);
    });

    it('announces changed counts once, then the all-clear', async () => {
      const w = await world();
      const agent = await w.agent('Pi');
      const p = await w.printer('Küche', agent);
      const job = await addJob(w.orgId, p, PrintJobStatus.QUEUED, 2 * MINUTE);
      const mine = () =>
        (gateway.notifyPrintHealthChanged.mock.calls as unknown[][])
          .map((c) => c[0] as { organizationId: string })
          .filter((e) => e.organizationId === w.orgId);

      await health.publishChanges();
      await health.publishChanges();
      expect(mine()).toEqual([
        { organizationId: w.orgId, waitingJobs: 1, failedJobs: 0 },
      ]);

      await q(`UPDATE print_jobs SET status = 'completed' WHERE id = $1`, [
        job,
      ]);
      await health.publishChanges();
      await health.publishChanges();
      expect(mine()).toEqual([
        { organizationId: w.orgId, waitingJobs: 1, failedJobs: 0 },
        { organizationId: w.orgId, waitingJobs: 0, failedJobs: 0 },
      ]);
    });
  });
});
