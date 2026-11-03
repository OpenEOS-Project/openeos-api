import { randomUUID } from 'crypto';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { Event, Organization, TseUnit } from '../../database/entities';
import type { TseConfig } from './tse.config';
import type { TseNotifyService } from './tse-notify.service';
import { TseAutoActivationService } from './tse-auto-activation.service';
import { TseUnitService } from './tse-unit.service';

/**
 * Cloud-TSE „All inclusive“ gegen ein echtes Postgres: das SQL zum
 * Einschalten der Integration (jsonb), Bestand → „Alle Funktionen“ mit
 * Verlauf und Protokoll, und die Automatik fuer genau eine Organisation.
 * Swissbit wird nie gerufen (`createUnit` ist ersetzt).
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:5561/openeos_tseauto_scratch pnpm test -- tse-auto-activation.db
 *
 * Name muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('Cloud-TSE all inclusive (database)', () => {
  let ds: DataSource;
  let auto: TseAutoActivationService;
  let units: TseUnitService;
  let created: string[];
  const orgIds: string[] = [];

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
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

    const config = { enabled: true, lifecycle: 'persistent' } as TseConfig;
    const notify = {
      settingsChanged: jest.fn(),
    } as unknown as TseNotifyService;
    const none = undefined as never;
    units = new TseUnitService(
      ds.getRepository(TseUnit),
      ds.getRepository(Organization),
      none,
      ds.getRepository(Event),
      none,
      ds,
      config,
      none,
      none,
      none,
      notify,
      none,
      none,
      { isSelfHosted: false } as never,
    );
    auto = new TseAutoActivationService(ds, config, units, notify, {
      get: () => 0,
    } as unknown as ConfigService);
  }, 180_000);

  beforeEach(() => {
    created = [];
    jest
      .spyOn(units, 'createUnit')
      .mockImplementation((organizationId: string) => {
        created.push(organizationId);
        return Promise.resolve({ id: randomUUID() } as TseUnit);
      });
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    if (orgIds.length) {
      for (const table of [
        'admin_audit_logs',
        'organization_operating_mode_changes',
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

  async function org(
    country: string,
    mode: string,
    legacy: boolean,
    settings: Record<string, unknown> = {},
  ): Promise<string> {
    const id = randomUUID();
    orgIds.push(id);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin, settings, country, operating_mode, operating_mode_legacy)
       VALUES ($1, 'Verein', $2, '123456', $3, $4, $5, $6)`,
      [
        id,
        `a-${id}`,
        JSON.stringify({
          taxNumber: '12/345/67890',
          address: { street: 'Hauptstr. 1', zip: '12345', city: 'Musterstadt' },
          ...settings,
        }),
        country,
        mode,
        legacy,
      ],
    );
    return id;
  }

  async function event(
    organizationId: string,
    start: Date,
    billingStatus = 'paid',
  ): Promise<string> {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO events (id, organization_id, name, start_date, end_date, billing_status)
       VALUES ($1, $2, 'Weihnachtsmarkt', $3, $4, $5)`,
      [
        id,
        organizationId,
        start,
        new Date(start.getTime() + 8 * 3600_000),
        billingStatus,
      ],
    );
    return id;
  }

  const orgRow = async (id: string) =>
    (
      await ds.query<
        {
          settings: { integrations?: { tse?: Record<string, unknown> } };
          operating_mode: string;
          operating_mode_legacy: boolean;
        }[]
      >(
        `SELECT settings, operating_mode, operating_mode_legacy FROM organizations WHERE id = $1`,
        [id],
      )
    )[0];

  const audits = (id: string) =>
    ds.query<{ action: string; reason: string | null; details: object }[]>(
      `SELECT action, reason, details FROM admin_audit_logs WHERE organization_id = $1 ORDER BY created_at`,
      [id],
    );

  it('DE full: enables the integration once, keeps other integrations, audits', async () => {
    const id = await org('DE', 'full', false, {
      integrations: { sumup: { enabled: true } },
    });
    const eventId = await event(id, new Date(Date.now() + 30 * 86400_000));
    const params = {
      organizationId: id,
      eventId,
      eventName: 'Weihnachtsmarkt',
      path: 'invoice' as const,
      withTse: undefined,
      actorUserId: null,
    };
    const first = await auto.onEventUnlocked(params);
    const second = await auto.onEventUnlocked(params);
    expect(first).toMatchObject({
      integrationEnabled: true,
      tseFollows: true,
      creationStarted: false,
      plan: { eventId },
    });
    expect(second.integrationEnabled).toBe(false);

    const row = await orgRow(id);
    expect(row.settings.integrations).toMatchObject({
      sumup: { enabled: true },
      tse: {
        enabled: true,
        auto: { source: 'purchase', eventId, path: 'invoice' },
      },
    });
    expect(await audits(id)).toEqual([
      expect.objectContaining({
        action: 'tse_integration_enabled',
        reason: 'automatisch beim Kauf',
      }),
    ]);
    // Erst im naechsten Monat: noch keine Anlage.
    expect(created).toEqual([]);
  });

  it('DE legacy + yes: explicit full, history, integration on; running event → TSE now', async () => {
    const id = await org('DE', 'full', true);
    const eventId = await event(id, new Date(Date.now() - 3600_000));
    const result = await auto.onEventUnlocked({
      organizationId: id,
      eventId,
      eventName: 'Weihnachtsmarkt',
      path: 'checkout',
      withTse: true,
      actorUserId: null,
    });
    expect(result).toMatchObject({ modeSwitched: true, creationStarted: true });
    expect(created).toEqual([id]);
    const row = await orgRow(id);
    expect(row).toMatchObject({
      operating_mode: 'full',
      operating_mode_legacy: false,
    });
    const history = await ds.query<{ from_mode: string; to_mode: string }[]>(
      `SELECT from_mode, to_mode FROM organization_operating_mode_changes WHERE organization_id = $1`,
      [id],
    );
    expect(history).toEqual([{ from_mode: 'full_legacy', to_mode: 'full' }]);
    expect((await audits(id)).map((a) => a.action).sort()).toEqual([
      'set_operating_mode',
      'tse_integration_enabled',
    ]);
  });

  it('DE legacy + no, cashless, AT: nothing changes', async () => {
    const cases = [
      { country: 'DE', mode: 'full', legacy: true, withTse: false },
      { country: 'DE', mode: 'cashless', legacy: false, withTse: true },
      { country: 'DE', mode: 'orders_only', legacy: false, withTse: true },
      { country: 'AT', mode: 'full', legacy: false, withTse: true },
    ];
    for (const c of cases) {
      const id = await org(c.country, c.mode, c.legacy);
      const eventId = await event(id, new Date(Date.now() - 3600_000));
      const result = await auto.onEventUnlocked({
        organizationId: id,
        eventId,
        eventName: 'Fest',
        path: 'waived',
        withTse: c.withTse,
        actorUserId: null,
      });
      expect(result.tseFollows).toBe(false);
      const row = await orgRow(id);
      expect(row.settings.integrations).toBeUndefined();
      expect(row.operating_mode_legacy).toBe(c.legacy);
      expect(await audits(id)).toEqual([]);
    }
    expect(created).toEqual([]);
  });

  it('autoCreate(now, org) only considers that organization', async () => {
    const a = await org('DE', 'full', false, {
      integrations: { tse: { enabled: true } },
    });
    const b = await org('DE', 'full', false, {
      integrations: { tse: { enabled: true } },
    });
    await event(a, new Date(Date.now() - 3600_000));
    await event(b, new Date(Date.now() - 3600_000));
    await units.autoCreate(new Date(), a);
    expect(created).toEqual([a]);
  });

  it('switch to full with a paid event enables the integration (source operating_mode)', async () => {
    const id = await org('DE', 'full', false);
    const eventId = await event(id, new Date(Date.now() + 30 * 86400_000));
    const result = await auto.onModeSwitchedToFull(id, null);
    expect(result).toMatchObject({ integrationEnabled: true });
    expect((await orgRow(id)).settings.integrations?.tse).toMatchObject({
      enabled: true,
      auto: { source: 'operating_mode', eventId },
    });

    const unpaid = await org('DE', 'full', false);
    await event(unpaid, new Date(Date.now() + 30 * 86400_000), 'none');
    expect((await auto.onModeSwitchedToFull(unpaid, null)).tseFollows).toBe(
      false,
    );
  });
});
