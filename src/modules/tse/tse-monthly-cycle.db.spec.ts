import { randomUUID } from 'crypto';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  Event,
  Organization,
  TseExport,
  TseTransaction,
  TseUnit,
  UserOrganization,
} from '../../database/entities';
import { SwissbitUnavailableError } from './swissbit/swissbit.errors';
import type { TseConfig } from './tse.config';
import { berlinTime } from './tse-dates';
import type { TseExportService } from './tse-export.service';
import { TseMonthlyCycleService } from './tse-monthly-cycle.service';
import type { TseNotifyService } from './tse-notify.service';
import { lifecycleOutlookOf } from './tse-status.service';
import { TseUnitService } from './tse-unit.service';

/**
 * Lebenszyklus `monthly` gegen ein echtes Postgres: Termin, Sperre je TSE,
 * Verschieben (jsonb), Abmeldung mit Protokoll, Fehler mit Backoff und
 * Warnung um 22:00, Gesundheitspruefung. Swissbit ist ein Fake, der
 * Abschlussexport wird als Zeile simuliert.
 *
 *   TEST_TSE_MONTHLY_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:5571/openeos_tsemonth_scratch \
 *     pnpm test -- tse-monthly-cycle.db
 *
 * Name muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_TSE_MONTHLY_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('Cloud-TSE monthly lifecycle (database)', () => {
  let ds: DataSource;
  let units: TseUnitService;
  let cycle: TseMonthlyCycleService;
  const client = {
    disableSecureElement: jest.fn(),
    listExports: jest.fn(),
  };
  const notify = {
    notifyAdmins: jest.fn(() => Promise.resolve()),
    notifyPlatformAdmins: jest.fn(() => Promise.resolve(true)),
    statusChanged: jest.fn(),
    settingsChanged: jest.fn(),
  };
  /** Ob der simulierte Abschlussexport fertig wird (Zeile `downloaded`). */
  let exportSucceeds = true;
  let simulatedNow = new Date();
  const collect = jest.fn(
    async (unit: TseUnit, options: { startNew: boolean; trigger: string }) => {
      if (!options.startNew || !exportSucceeds) return [];
      await ds.query(
        `INSERT INTO tse_exports (organization_id, tse_unit_id, serial_number, swissbit_export_id, status, trigger, downloaded_at, created_at)
         VALUES ($1, $2, $3, $4, 'downloaded', $5, $6, $6)`,
        [
          unit.organizationId,
          unit.id,
          unit.serialNumber,
          randomUUID(),
          options.trigger,
          simulatedNow,
        ],
      );
      return [];
    },
  );
  const orgIds: string[] = [];

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name)) {
      throw new Error(`Database "${name}" does not end in _test/_scratch`);
    }
    ds = new DataSource({
      type: 'postgres',
      url: TEST_DB,
      entities: [path.join(__dirname, '../../database/entities/*.entity.ts')],
      migrations: [path.join(__dirname, '../../database/migrations/*.ts')],
      migrationsRun: true,
      logging: false,
    });
    await ds.initialize();

    const config = {
      enabled: true,
      lifecycle: 'monthly',
      settings: { swissbit: { productType: '850007' } },
    } as unknown as TseConfig;
    units = new TseUnitService(
      ds.getRepository(TseUnit),
      ds.getRepository(Organization),
      ds.getRepository(UserOrganization),
      ds.getRepository(Event),
      ds.getRepository(TseTransaction),
      ds,
      config,
      { client, hasVendorCredentials: false } as never,
      {
        encrypt: (s: string) => `enc:${s}`,
        decrypt: (s: string) => s.replace(/^enc:/, ''),
      } as never,
      { invalidate: jest.fn() } as never,
      notify as unknown as TseNotifyService,
      {} as never,
      { runExclusive: jest.fn() } as never,
      { isSelfHosted: false } as never,
    );
    cycle = new TseMonthlyCycleService(
      ds.getRepository(TseUnit),
      ds.getRepository(TseExport),
      ds,
      config,
      units,
      { collect } as unknown as TseExportService,
      notify as unknown as TseNotifyService,
      { runExclusive: jest.fn() } as never,
      {
        get: () => {
          throw new Error('no dsfinvk in this test');
        },
      } as never,
    );
    cycle.retryDelaysMs = [0, 0];
  }, 180_000);

  beforeEach(async () => {
    jest.clearAllMocks();
    exportSucceeds = true;
    client.disableSecureElement.mockResolvedValue({
      value: null,
      requestId: 'r',
      durationMs: 1,
    });
    // Jeder Test sieht nur seine TSEs.
    await ds.query(
      `UPDATE tse_units SET state = 'deactivated' WHERE state = 'active'`,
    );
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    if (orgIds.length) {
      for (const table of [
        'admin_audit_logs',
        'tse_exports',
        'tse_units',
        'events',
      ]) {
        await ds.query(
          `DELETE FROM ${table} WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
      }
      await ds.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
        orgIds,
      ]);
    }
    await ds.destroy();
  });

  async function org(): Promise<string> {
    const id = randomUUID();
    orgIds.push(id);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin, settings, country, operating_mode, operating_mode_legacy, tse_active)
       VALUES ($1, 'Verein', $2, '123456', $3, 'DE', 'full', false, true)`,
      [
        id,
        `m-${id}`,
        JSON.stringify({
          taxNumber: '12/345/67890',
          address: { street: 'Hauptstr. 1', zip: '12345', city: 'Musterstadt' },
          integrations: { tse: { enabled: true } },
        }),
      ],
    );
    return id;
  }

  async function event(
    organizationId: string,
    start: Date,
    end: Date | null,
    billingStatus = 'paid',
    name = 'Fest',
  ): Promise<string> {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO events (id, organization_id, name, start_date, end_date, billing_status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, organizationId, name, start, end, billingStatus],
    );
    return id;
  }

  async function activeUnit(
    organizationId: string,
    planned: Date | null,
  ): Promise<string> {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO tse_units (id, organization_id, state, serial_number, access_token_enc, product_type, client_id, trigger, activated_at, planned_deactivation_at)
       VALUES ($1, $2, 'active', $3, 'enc:token', '850007', 'OEOS-TEST', 'auto', $4, $5)`,
      [id, organizationId, `ff${id.replace(/-/g, '')}`, new Date(), planned],
    );
    return id;
  }

  const unitRow = async (id: string) =>
    (
      await ds.query<
        {
          state: string;
          deactivation_reason: string | null;
          planned_deactivation_at: Date | null;
          deactivation_attempts: number;
          deactivation_next_attempt_at: Date | null;
          deactivation_alerted_at: Date | null;
          last_error_code: string | null;
          metadata: {
            postponements?: Array<Record<string, unknown>>;
            keeps?: Array<Record<string, unknown>>;
          };
        }[]
      >(`SELECT * FROM tse_units WHERE id = $1`, [id])
    )[0];

  const actions = async (organizationId: string) =>
    (
      await ds.query<
        {
          action: string;
          reason: string | null;
          details: Record<string, string>;
        }[]
      >(
        `SELECT action, reason, details FROM admin_audit_logs WHERE organization_id = $1 ORDER BY created_at`,
        [organizationId],
      )
    ).map((r) => r);

  async function runAt(now: Date) {
    simulatedNow = now;
    return cycle.run(now);
  }

  const planned = berlinTime(2026, 11, 30, 20);

  it('event mid-month: nothing until 18:00, final export at 18:00, deactivation at 20:00 with TSE-change entry', async () => {
    const o = await org();
    await event(o, berlinTime(2026, 11, 14, 14), berlinTime(2026, 11, 15, 2));
    const u = await activeUnit(o, planned);

    expect((await runAt(berlinTime(2026, 11, 20, 12)))[u]).toBeUndefined();
    expect((await runAt(berlinTime(2026, 11, 30, 18)))[u]).toBe('prepared');
    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({ id: u }),
      expect.objectContaining({ startNew: true, trigger: 'final' }),
    );
    expect((await unitRow(u)).state).toBe('active');

    expect((await runAt(berlinTime(2026, 11, 30, 20)))[u]).toBe('deactivated');
    const row = await unitRow(u);
    expect(row).toMatchObject({
      state: 'deactivated',
      deactivation_reason: 'monthly_cycle',
    });
    expect(client.disableSecureElement).toHaveBeenCalledTimes(1);
    const orgRows = await ds.query<{ tse_active: boolean; settings: any }[]>(
      `SELECT tse_active, settings FROM organizations WHERE id = $1`,
      [o],
    );
    // Integration bleibt an: die naechste Veranstaltung bekommt eine neue TSE.
    expect(orgRows[0]).toMatchObject({
      tse_active: false,
      settings: { integrations: { tse: { enabled: true } } },
    });
    const deactivated = (await actions(o)).find(
      (a) => a.action === 'tse_deactivated',
    );
    expect(deactivated?.details).toMatchObject({
      reason: 'monthly_cycle',
      period: { activatedAt: expect.any(String) as unknown },
    });
    expect(notify.notifyAdmins).toHaveBeenCalledWith(
      o,
      'monthly_deactivated',
      expect.anything(),
    );
    // Idempotent: ein weiterer Lauf tut nichts.
    expect((await runAt(berlinTime(2026, 11, 30, 20, 15)))[u]).toBeUndefined();
    expect(client.disableSecureElement).toHaveBeenCalledTimes(1);
  });

  it('two events in the same month: the TSE is kept between them and only deactivated at month end', async () => {
    const o = await org();
    await event(o, berlinTime(2026, 11, 7, 14), berlinTime(2026, 11, 7, 23));
    await event(o, berlinTime(2026, 11, 21, 14), berlinTime(2026, 11, 22, 1));
    const u = await activeUnit(o, planned);
    await runAt(berlinTime(2026, 11, 8, 20));
    await runAt(berlinTime(2026, 11, 23, 20));
    expect((await unitRow(u)).state).toBe('active');
    expect((await runAt(berlinTime(2026, 11, 30, 20)))[u]).toBe('deactivated');
  });

  it('event on the last day running past midnight: postponed to the end of next month with cost note', async () => {
    const o = await org();
    const e = await event(
      o,
      berlinTime(2026, 11, 30, 18),
      berlinTime(2026, 12, 1, 2),
      'paid',
      'Nikolausparty',
    );
    const u = await activeUnit(o, planned);
    expect((await runAt(berlinTime(2026, 11, 30, 18)))[u]).toBe('postponed');
    const row = await unitRow(u);
    expect(row.state).toBe('active');
    expect(row.planned_deactivation_at?.toISOString()).toBe(
      '2026-12-31T19:00:00.000Z',
    );
    expect(row.metadata.postponements).toEqual([
      expect.objectContaining({
        reason: 'paid_event_running',
        extraMonth: '2026-12',
        events: [expect.objectContaining({ id: e, name: 'Nikolausparty' })],
      }),
    ]);
    const audit = (await actions(o)).find(
      (a) => a.action === 'tse_deactivation_postponed',
    );
    expect(audit?.reason).toContain('Nikolausparty');
    expect(audit?.details.costNote).toContain('Dezember 2026');
    expect(client.disableSecureElement).not.toHaveBeenCalled();
    // Nach dem Verschieben bis kurz vor Ende Dezember nichts mehr.
    expect((await runAt(berlinTime(2026, 11, 30, 20)))[u]).toBeUndefined();
    expect((await runAt(berlinTime(2026, 12, 31, 20)))[u]).toBe('deactivated');
  });

  it('event spanning two months (created in its first month): kept until the end of the second month', async () => {
    const o = await org();
    await event(o, berlinTime(2026, 10, 30, 10), berlinTime(2026, 11, 2, 23));
    const u = await activeUnit(o, berlinTime(2026, 10, 31, 20));
    expect((await runAt(berlinTime(2026, 10, 31, 20)))[u]).toBe('postponed');
    expect((await unitRow(u)).planned_deactivation_at?.toISOString()).toBe(
      '2026-11-30T19:00:00.000Z',
    );
    expect((await runAt(berlinTime(2026, 11, 30, 20)))[u]).toBe('deactivated');
  });

  it('unpaid and test events never keep a TSE alive', async () => {
    const o = await org();
    await event(
      o,
      berlinTime(2026, 11, 30, 18),
      berlinTime(2026, 12, 1, 2),
      'none',
    );
    const u = await activeUnit(o, planned);
    expect((await runAt(berlinTime(2026, 11, 30, 20)))[u]).toBe('deactivated');
  });

  it('final export missing: waits until 21:00, then deactivates anyway', async () => {
    exportSucceeds = false;
    const o = await org();
    const u = await activeUnit(o, planned);
    expect((await runAt(berlinTime(2026, 11, 30, 20)))[u]).toBe(
      'waiting_for_export',
    );
    expect((await runAt(berlinTime(2026, 11, 30, 20, 45)))[u]).toBe(
      'waiting_for_export',
    );
    expect((await runAt(berlinTime(2026, 11, 30, 21)))[u]).toBe('deactivated');
  });

  it('deactivation failure: retries with backoff, alerts the platform admins once at 22:00, then succeeds', async () => {
    const o = await org();
    const u = await activeUnit(o, planned);
    client.disableSecureElement.mockRejectedValue(
      new SwissbitUnavailableError({
        operation: 'disableSecureElement',
        status: 503,
        errorCode: 'E_MAINTENANCE_IN_PROGRESS',
        message: 'down',
        requestId: 'req-1',
      }),
    );

    expect((await runAt(berlinTime(2026, 11, 30, 20)))[u]).toBe('failed');
    // In-run retries: 3 calls per run.
    expect(client.disableSecureElement).toHaveBeenCalledTimes(3);
    let row = await unitRow(u);
    expect(row.deactivation_attempts).toBe(1);
    expect(row.last_error_code).toBe('E_MAINTENANCE_IN_PROGRESS');
    expect(row.deactivation_next_attempt_at?.toISOString()).toBe(
      new Date(
        berlinTime(2026, 11, 30, 20).getTime() + 5 * 60_000,
      ).toISOString(),
    );
    // Backoff: 20:03 wartet noch.
    expect((await runAt(berlinTime(2026, 11, 30, 20, 3)))[u]).toBe('backoff');
    expect((await runAt(berlinTime(2026, 11, 30, 20, 15)))[u]).toBe('failed');
    expect((await unitRow(u)).deactivation_attempts).toBe(2);

    expect(notify.notifyPlatformAdmins).not.toHaveBeenCalled();
    await runAt(berlinTime(2026, 11, 30, 22));
    expect(notify.notifyPlatformAdmins).toHaveBeenCalledTimes(1);
    expect(notify.notifyPlatformAdmins).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining('überfällig') as unknown,
      }),
    );
    expect((await actions(o)).map((a) => a.action)).toContain(
      'tse_deactivation_overdue',
    );
    // Kein zweites Mal fuer denselben Termin.
    await runAt(berlinTime(2026, 11, 30, 22, 15));
    expect(notify.notifyPlatformAdmins).toHaveBeenCalledTimes(1);
    const overdue = await cycle.healthCheck(berlinTime(2026, 11, 30, 22, 20));
    expect(overdue.map((i) => [i.unitId, i.kind])).toContainEqual([
      u,
      'deactivation_overdue',
    ]);

    client.disableSecureElement.mockResolvedValue({
      value: null,
      requestId: 'r',
      durationMs: 1,
    });
    expect((await runAt(berlinTime(2026, 11, 30, 23)))[u]).toBe('deactivated');
    row = await unitRow(u);
    expect(row.state).toBe('deactivated');
  });

  it('is lock-protected: a second instance skips a TSE in progress', async () => {
    const o = await org();
    const u = await activeUnit(o, planned);
    await ds.query(
      `UPDATE tse_units SET job_locked_until = now() + interval '5 minutes' WHERE id = $1`,
      [u],
    );
    expect((await runAt(berlinTime(2026, 11, 30, 20)))[u]).toBe('locked');
    expect(client.disableSecureElement).not.toHaveBeenCalled();
    await ds.query(
      `UPDATE tse_units SET job_locked_until = NULL WHERE id = $1`,
      [u],
    );
    expect((await runAt(berlinTime(2026, 11, 30, 20, 15)))[u]).toBe(
      'deactivated',
    );
  });

  it('DST month end (March, CEST): deactivates at 20:00 local = 18:00 UTC', async () => {
    const o = await org();
    const marchEnd = berlinTime(2027, 3, 31, 20);
    expect(marchEnd.toISOString()).toBe('2027-03-31T18:00:00.000Z');
    const u = await activeUnit(o, marchEnd);
    expect((await runAt(new Date('2027-03-31T17:59:00.000Z')))[u]).toBe(
      'prepared',
    );
    expect((await runAt(new Date('2027-03-31T18:00:00.000Z')))[u]).toBe(
      'deactivated',
    );
  });

  it('backfills a planned date for active TSEs from before this version', async () => {
    const o = await org();
    const u = await activeUnit(o, null);
    await runAt(berlinTime(2026, 11, 4, 12));
    expect((await unitRow(u)).planned_deactivation_at?.toISOString()).toBe(
      '2026-11-30T19:00:00.000Z',
    );
  });

  it('health check: active TSE in a month without a paid event is reported (and mailed)', async () => {
    const withEvent = await org();
    await event(
      withEvent,
      berlinTime(2026, 11, 20, 14),
      berlinTime(2026, 11, 20, 23),
    );
    const okUnit = await activeUnit(withEvent, planned);
    const without = await org();
    const badUnit = await activeUnit(without, planned);
    const issues = await cycle.healthCheck(berlinTime(2026, 11, 10, 7), {
      alert: true,
    });
    const kinds = issues.map((i) => [i.unitId, i.kind]);
    expect(kinds).toContainEqual([badUnit, 'no_paid_event_this_month']);
    expect(kinds.find(([id]) => id === okUnit)).toBeUndefined();
    expect(notify.notifyPlatformAdmins).toHaveBeenCalledTimes(1);
  });

  describe('paid event already booked next month (decision 2026-11-06)', () => {
    const setBilling = (id: string, status: string) =>
      ds.query(`UPDATE events SET billing_status = $2 WHERE id = $1`, [
        id,
        status,
      ]);
    const finalExports = async (unitId: string) =>
      Number(
        (
          await ds.query<{ n: string }[]>(
            `SELECT count(*) AS n FROM tse_exports WHERE tse_unit_id = $1 AND trigger = 'final'`,
            [unitId],
          )
        )[0].n,
      );

    it('keeps the TSE into December (no final export), no false alerts, deactivates at the end of December', async () => {
      const o = await org();
      await event(o, berlinTime(2026, 11, 14, 14), berlinTime(2026, 11, 15, 2));
      const dec = await event(
        o,
        berlinTime(2026, 12, 12, 15),
        berlinTime(2026, 12, 12, 23),
        'invoice',
        'Weihnachtsmarkt',
      );
      const u = await activeUnit(o, planned);

      // Prognose schon vorher (Status, /admin/tse).
      const outlook = lifecycleOutlookOf(
        await ds.getRepository(TseUnit).findOneByOrFail({ id: u }),
        await units.paidEventsAround(o, planned),
      );
      expect(outlook).toMatchObject({
        expectedDeactivationAt: '2026-12-31T19:00:00.000Z',
        months: [
          {
            month: '2026-12',
            reason: 'paid_event_next_month',
            decided: false,
            events: [
              expect.objectContaining({ id: dec, name: 'Weihnachtsmarkt' }),
            ],
          },
        ],
      });

      expect((await runAt(berlinTime(2026, 11, 30, 18)))[u]).toBe('keeping');
      expect((await runAt(berlinTime(2026, 11, 30, 20)))[u]).toBe('kept');
      const row = await unitRow(u);
      expect(row.state).toBe('active');
      expect(row.planned_deactivation_at?.toISOString()).toBe(
        '2026-12-31T19:00:00.000Z',
      );
      expect(row.metadata.keeps).toEqual([
        expect.objectContaining({
          reason: 'paid_event_next_month',
          month: '2026-12',
          events: [expect.objectContaining({ id: dec })],
        }),
      ]);
      expect(row.metadata.postponements).toBeUndefined();
      expect(await finalExports(u)).toBe(0);
      expect(client.disableSecureElement).not.toHaveBeenCalled();
      const audit = (await actions(o)).find(
        (a) => a.action === 'tse_kept_for_next_month',
      );
      expect(audit?.details).toMatchObject({ eventId: dec, month: '2026-12' });
      expect(audit?.reason).toContain('Weihnachtsmarkt');
      expect(notify.notifyAdmins).not.toHaveBeenCalled();

      // Nach Entscheidung: bis Monatswechsel nachgeprueft, nichts passiert.
      expect((await runAt(berlinTime(2026, 11, 30, 22)))[u]).toBe('kept');
      expect(notify.notifyPlatformAdmins).not.toHaveBeenCalled();
      expect((await runAt(berlinTime(2026, 12, 1, 0, 15)))[u]).toBeUndefined();
      // Keine Fehlalarme im Dezember (Gesundheitspruefung, /admin/tse/alerts).
      for (const at of [
        berlinTime(2026, 11, 30, 22, 30),
        berlinTime(2026, 12, 1, 7),
        berlinTime(2026, 12, 20, 7),
      ]) {
        const issues = await cycle.healthCheck(at);
        expect(issues.filter((i) => i.unitId === u)).toEqual([]);
      }
      const keptOutlook = lifecycleOutlookOf(
        await ds.getRepository(TseUnit).findOneByOrFail({ id: u }),
        await units.paidEventsAround(o, berlinTime(2026, 12, 31, 20)),
      );
      expect(keptOutlook).toMatchObject({
        expectedDeactivationAt: '2026-12-31T19:00:00.000Z',
        months: [{ month: '2026-12', decided: true }],
      });

      expect((await runAt(berlinTime(2026, 12, 31, 18)))[u]).toBe('prepared');
      expect((await runAt(berlinTime(2026, 12, 31, 20)))[u]).toBe(
        'deactivated',
      );
      expect(await finalExports(u)).toBe(1);
    });

    it('only unpaid or cancelled events next month: deactivates normally', async () => {
      const o = await org();
      await event(
        o,
        berlinTime(2026, 12, 5, 15),
        berlinTime(2026, 12, 5, 23),
        'none',
      );
      await event(
        o,
        berlinTime(2026, 12, 6, 15),
        berlinTime(2026, 12, 6, 23),
        'pending',
      );
      const cancelled = await event(
        o,
        berlinTime(2026, 12, 7, 15),
        null,
        'paid',
      );
      await setBilling(cancelled, 'none'); // storniert/erstattet → 'none'
      const u = await activeUnit(o, planned);
      expect((await runAt(berlinTime(2026, 11, 30, 18)))[u]).toBe('prepared');
      expect((await runAt(berlinTime(2026, 11, 30, 20)))[u]).toBe(
        'deactivated',
      );
      expect((await actions(o)).map((a) => a.action)).not.toContain(
        'tse_kept_for_next_month',
      );
    });

    it('event refunded after the decision but before the month change: keep revoked, deactivated the same evening', async () => {
      const o = await org();
      const dec = await event(
        o,
        berlinTime(2026, 12, 12, 15),
        berlinTime(2026, 12, 12, 23),
      );
      const u = await activeUnit(o, planned);
      expect((await runAt(berlinTime(2026, 11, 30, 20)))[u]).toBe('kept');
      await setBilling(dec, 'none');
      // Naechster Lauf: Abschlussexport (jetzt doch) und Abmeldung.
      expect((await runAt(berlinTime(2026, 11, 30, 20, 15)))[u]).toBe(
        'deactivated',
      );
      expect(await finalExports(u)).toBe(1);
      const row = await unitRow(u);
      expect(row.state).toBe('deactivated');
      expect(row.metadata.keeps?.[0]).toMatchObject({
        revokedAt: expect.any(String) as unknown,
      });
      expect((await actions(o)).map((a) => a.action)).toEqual(
        expect.arrayContaining([
          'tse_kept_for_next_month',
          'tse_keep_revoked',
          'tse_deactivated',
        ]),
      );
    });

    it('event refunded after 22:00: revoked and deactivated in the same run (before the overdue alert)', async () => {
      exportSucceeds = false;
      const o = await org();
      const dec = await event(o, berlinTime(2026, 12, 12, 15), null);
      const u = await activeUnit(o, planned);
      expect((await runAt(berlinTime(2026, 11, 30, 20)))[u]).toBe('kept');
      await setBilling(dec, 'none');
      expect((await runAt(berlinTime(2026, 11, 30, 22, 15)))[u]).toBe(
        'deactivated',
      );
      expect(notify.notifyPlatformAdmins).toHaveBeenCalledTimes(0);
    });

    it('event refunded after the month change: TSE runs the month, health check reports it', async () => {
      const o = await org();
      const dec = await event(o, berlinTime(2026, 12, 12, 15), null);
      const u = await activeUnit(o, planned);
      expect((await runAt(berlinTime(2026, 11, 30, 20)))[u]).toBe('kept');
      await setBilling(dec, 'none');
      expect((await runAt(berlinTime(2026, 12, 1, 0, 15)))[u]).toBeUndefined();
      expect((await unitRow(u)).state).toBe('active');
      const issues = await cycle.healthCheck(berlinTime(2026, 12, 1, 7));
      expect(issues.map((i) => [i.unitId, i.kind])).toContainEqual([
        u,
        'no_paid_event_this_month',
      ]);
    });

    it('event booked late on the last day (after 18:00): kept at 20:00', async () => {
      const o = await org();
      const u = await activeUnit(o, planned);
      expect((await runAt(berlinTime(2026, 11, 30, 18)))[u]).toBe('prepared');
      await event(o, berlinTime(2026, 12, 3, 18), null);
      expect((await runAt(berlinTime(2026, 11, 30, 20)))[u]).toBe('kept');
    });

    it('multi-month: December and January booked → kept twice, deactivated end of January', async () => {
      const o = await org();
      await event(
        o,
        berlinTime(2026, 12, 12, 15),
        null,
        'paid',
        'Weihnachtsmarkt',
      );
      await event(
        o,
        berlinTime(2027, 1, 16, 18),
        null,
        'waived',
        'Neujahrsempfang',
      );
      const u = await activeUnit(o, planned);
      const outlook = lifecycleOutlookOf(
        await ds.getRepository(TseUnit).findOneByOrFail({ id: u }),
        await units.paidEventsAround(o, planned),
      );
      expect(outlook?.expectedDeactivationAt).toBe('2027-01-31T19:00:00.000Z');
      expect(outlook?.months.map((m) => m.month)).toEqual([
        '2026-12',
        '2027-01',
      ]);

      expect((await runAt(berlinTime(2026, 11, 30, 20)))[u]).toBe('kept');
      expect((await runAt(berlinTime(2026, 12, 31, 20)))[u]).toBe('kept');
      expect((await unitRow(u)).planned_deactivation_at?.toISOString()).toBe(
        '2027-01-31T19:00:00.000Z',
      );
      expect((await unitRow(u)).metadata.keeps?.map((k) => k.month)).toEqual([
        '2026-12',
        '2027-01',
      ]);
      expect((await runAt(berlinTime(2027, 1, 31, 20)))[u]).toBe('deactivated');
    });

    it('event spanning December into January: kept for December, then postponed (running) into January', async () => {
      const o = await org();
      await event(
        o,
        berlinTime(2026, 12, 28, 10),
        berlinTime(2027, 1, 3, 22),
        'paid',
        'Winterdorf',
      );
      const u = await activeUnit(o, planned);
      expect((await runAt(berlinTime(2026, 11, 30, 20)))[u]).toBe('kept');
      expect((await runAt(berlinTime(2026, 12, 31, 18)))[u]).toBe('postponed');
      expect((await unitRow(u)).planned_deactivation_at?.toISOString()).toBe(
        '2027-01-31T19:00:00.000Z',
      );
      expect((await runAt(berlinTime(2027, 1, 31, 20)))[u]).toBe('deactivated');
    });

    it('a gap month ends the chain: event in January only → deactivated end of November', async () => {
      const o = await org();
      await event(o, berlinTime(2027, 1, 16, 18), null);
      const u = await activeUnit(o, planned);
      expect((await runAt(berlinTime(2026, 11, 30, 20)))[u]).toBe(
        'deactivated',
      );
    });
  });
});
