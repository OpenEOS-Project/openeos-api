import { randomUUID } from 'crypto';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import {
  Organization,
  User,
  UserOrganization,
} from '../../../database/entities';
import { tseStatus } from '../../../common/utils/tse.util';
import { OrganizationsService } from '../organizations.service';
import { CountryService } from '../country/country.service';
import { OperatingModeService } from './operating-mode.service';

/**
 * Betriebsarten gegen ein echtes Postgres: Uebernahme der Zwischenstaende
 * durch die Migration (betriebsarten-spec.md §3), Wechsel mit Sperre,
 * Verlauf und Admin-Protokoll, Land einmalig setzen.
 *
 * Laeuft nur mit einer Wegwerf-Datenbank, z. B.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:5547/openeos_modes_scratch pnpm test
 *
 * Name muss auf `_test` oder `_scratch` enden. Die Migrationspruefung legt
 * daneben eine eigene Datenbank `<name>_migration_scratch` an (sie nimmt
 * die letzte Migration zurueck und spielt sie erneut ein).
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

function dataSource(url: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    entities: [path.join(__dirname, '../../../database/entities/*.entity.ts')],
    migrations: [path.join(__dirname, '../../../database/migrations/*.ts')],
    migrationsRun: true,
    logging: false,
  });
}

function assertScratch(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!/_(test|scratch)$/.test(name)) {
    throw new Error(`Database "${name}" does not end in _test/_scratch`);
  }
}

describeWithDb('Operating modes: migration of the interim states', () => {
  let ds: DataSource;

  type Row = {
    id: string;
    operating_mode: string;
    operating_mode_legacy: boolean;
    operating_mode_since: Date | null;
    settings: Record<string, unknown>;
  };

  const ids = {
    deLegacy: randomUUID(),
    atCashless: randomUUID(),
    orderOnly: randomUUID(),
    deNew: randomUUID(),
    atNew: randomUUID(),
    noCountry: randomUUID(),
    both: randomUUID(),
  };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    assertScratch(TEST_DB!);
    const url = new URL(TEST_DB!);
    const migrationDb = `${url.pathname.replace(/^\//, '').replace(/_(test|scratch)$/, '')}_migration_scratch`;
    const admin = new DataSource({ type: 'postgres', url: TEST_DB });
    await admin.initialize();
    await admin.query(`DROP DATABASE IF EXISTS "${migrationDb}"`);
    await admin.query(`CREATE DATABASE "${migrationDb}"`);
    await admin.destroy();
    url.pathname = `/${migrationDb}`;
    ds = dataSource(url.toString());
    await ds.initialize();

    // Zurueck auf den Stand vor den Betriebsarten (Zwischenloesungen):
    // spaetere Migrationen zuerst zuruecknehmen.
    for (;;) {
      const last = await ds.query<{ name: string }[]>(
        `SELECT name FROM migrations ORDER BY id DESC LIMIT 1`,
      );
      const name = last[0].name;
      await ds.undoLastMigration();
      if (name === 'IntroduceOperatingModes1834000000000') break;
    }

    const org = (
      id: string,
      country: string | null,
      legacy: boolean,
      settings: Record<string, unknown>,
    ) =>
      ds.query(
        `INSERT INTO organizations (id, name, slug, support_pin, settings, country, cash_policy_legacy)
         VALUES ($1, 'Verein', $2, '123456', $3, $4, $5)`,
        [id, `v-${id}`, JSON.stringify(settings), country, legacy],
      );
    await org(ids.deLegacy, 'DE', true, { currency: 'EUR' });
    await org(ids.atCashless, 'AT', true, {
      payments: { cashless: true, changedAt: '2026-10-20T08:00:00.000Z' },
    });
    await org(ids.orderOnly, 'DE', true, {
      operatingMode: 'order_only',
      operatingModeSince: '2026-11-01T09:00:00.000Z',
    });
    await ds.query(
      `INSERT INTO organization_operating_mode_changes
         (organization_id, created_at, from_mode, to_mode, reason)
       VALUES ($1, '2026-11-01T09:00:00Z', 'pos', 'order_only', 'Antrag per E-Mail')`,
      [ids.orderOnly],
    );
    await org(ids.deNew, 'DE', false, {});
    await org(ids.atNew, 'AT', false, {});
    await org(ids.noCountry, null, true, {
      payments: { cashless: false, keep: 1 },
    });
    await org(ids.both, 'DE', true, {
      operatingMode: 'order_only',
      payments: { cashless: true },
    });

    await ds.runMigrations();
  }, 180_000);

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const row = async (id: string): Promise<Row> =>
    (
      await ds.query<Row[]>(
        `SELECT id, operating_mode, operating_mode_legacy, operating_mode_since, settings
           FROM organizations WHERE id = $1`,
        [id],
      )
    )[0];
  const history = (id: string) =>
    ds.query<
      {
        from_mode: string;
        to_mode: string;
        reason: string | null;
        by_support: boolean;
      }[]
    >(
      `SELECT from_mode, to_mode, reason, by_support
         FROM organization_operating_mode_changes
        WHERE organization_id = $1 ORDER BY created_at`,
      [id],
    );

  it('legacy organizations stay full (legacy), without a history row', async () => {
    for (const id of [ids.deLegacy, ids.noCountry]) {
      expect(await row(id)).toMatchObject({
        operating_mode: 'full',
        operating_mode_legacy: true,
      });
      expect(await history(id)).toEqual([]);
    }
  });

  it('settings.payments.cashless = true → cashless', async () => {
    const r = await row(ids.atCashless);
    expect(r).toMatchObject({
      operating_mode: 'cashless',
      operating_mode_legacy: false,
    });
    expect(new Date(r.operating_mode_since!).toISOString()).toBe(
      '2026-10-20T08:00:00.000Z',
    );
    expect(r.settings).not.toHaveProperty('payments');
    expect(await history(ids.atCashless)).toEqual([
      {
        from_mode: 'full_legacy',
        to_mode: 'cashless',
        reason: 'Umstellung auf Betriebsarten (vorher: bargeldloser Modus)',
        by_support: true,
      },
    ]);
  });

  it('operatingMode = order_only → orders_only, old history rewritten', async () => {
    const r = await row(ids.orderOnly);
    expect(r).toMatchObject({
      operating_mode: 'orders_only',
      operating_mode_legacy: false,
    });
    expect(r.settings).not.toHaveProperty('operatingMode');
    expect(r.settings).not.toHaveProperty('operatingModeSince');
    expect(await history(ids.orderOnly)).toEqual([
      {
        from_mode: 'full',
        to_mode: 'orders_only',
        reason: 'Antrag per E-Mail',
        by_support: true,
      },
    ]);
  });

  it('cash_policy blocked_de_no_tse (new DE organization) → cashless', async () => {
    expect(await row(ids.deNew)).toMatchObject({
      operating_mode: 'cashless',
      operating_mode_legacy: false,
    });
    expect(await history(ids.deNew)).toEqual([
      {
        from_mode: 'full',
        to_mode: 'cashless',
        reason:
          'Umstellung auf Betriebsarten (vorher: Regel „Deutschland ohne Bargeld“)',
        by_support: true,
      },
    ]);
  });

  it('new organizations outside DE → full, not legacy', async () => {
    expect(await row(ids.atNew)).toMatchObject({
      operating_mode: 'full',
      operating_mode_legacy: false,
    });
  });

  it('order-only wins over cashless; other payment keys stay', async () => {
    expect(await row(ids.both)).toMatchObject({
      operating_mode: 'orders_only',
    });
    expect((await row(ids.noCountry)).settings).toEqual({
      payments: { keep: 1 },
    });
  });

  it('new rows default to full, not legacy', async () => {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin) VALUES ($1, 'Neu', $2, '123456')`,
      [id, `n-${id}`],
    );
    expect(await row(id)).toMatchObject({
      operating_mode: 'full',
      operating_mode_legacy: false,
    });
  });
});

describeWithDb('Operating modes against Postgres', () => {
  let ds: DataSource;
  const orgIds: string[] = [];
  let admin: User;
  let superAdmin: User;
  let modes: OperatingModeService;
  let countries: CountryService;
  const gateway = { notifyOrganizationSettingsUpdated: jest.fn() };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    assertScratch(TEST_DB!);
    ds = dataSource(TEST_DB!);
    await ds.initialize();
    const none = undefined as never;
    const organizations = new OrganizationsService(
      ds.getRepository(Organization),
      ds.getRepository(User),
      ds.getRepository(UserOrganization),
      none,
      ds,
      none,
      none,
      none,
      { isSelfHosted: false, multiTenant: true } as never,
      none,
    );
    modes = new OperatingModeService(
      ds,
      organizations,
      { get: () => undefined } as never,
      { isSelfHosted: false } as never,
      gateway as never,
    );
    countries = new CountryService(ds, organizations, gateway as never);
    const mkUser = async (superAdminFlag: boolean) => {
      const [u] = await ds.query<{ id: string }[]>(
        `INSERT INTO users (email, first_name, last_name, is_active, is_superadmin)
         VALUES ($1, 'Ada', 'Admin', true, $2) RETURNING id`,
        [`modes-${randomUUID()}@example.org`, superAdminFlag],
      );
      return {
        id: u.id,
        email: 'ada@example.org',
        firstName: 'Ada',
        lastName: 'Admin',
        isSuperAdmin: superAdminFlag,
      } as User;
    };
    admin = await mkUser(false);
    superAdmin = await mkUser(true);
  }, 120_000);

  afterEach(() => {
    tseStatus.isActive = () => false;
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      if (orgIds.length) {
        await ds.query(
          `DELETE FROM admin_audit_logs WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
        await ds.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
          orgIds,
        ]);
      }
      await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
        [admin?.id, superAdmin?.id].filter(Boolean),
      ]);
      await ds.destroy();
    }
  });

  async function org(
    country: string | null,
    mode = 'full',
    legacy = true,
  ): Promise<string> {
    const id = randomUUID();
    orgIds.push(id);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin, settings, country, operating_mode, operating_mode_legacy)
       VALUES ($1, 'Verein', $2, '123456', '{}', $3, $4, $5)`,
      [id, `m-${id}`, country, mode, legacy],
    );
    await ds.query(
      `INSERT INTO user_organizations (user_id, organization_id, role)
       VALUES ($1, $2, 'admin')`,
      [admin.id, id],
    );
    return id;
  }

  it('a DE legacy club picks cashless: columns, history and audit are written', async () => {
    const id = await org('DE');
    const state = await modes.setByMember(id, 'cashless', admin);
    expect(state).toMatchObject({
      operatingMode: 'cashless',
      operatingModeLegacy: false,
      cashAllowed: false,
      certificateAvailable: true,
    });
    const [r] = await ds.query<
      { operating_mode: string; operating_mode_legacy: boolean }[]
    >(
      `SELECT operating_mode, operating_mode_legacy FROM organizations WHERE id = $1`,
      [id],
    );
    expect(r).toEqual({
      operating_mode: 'cashless',
      operating_mode_legacy: false,
    });
    const view = await modes.getForMember(id, admin);
    expect(view.history).toHaveLength(1);
    expect(view.history[0]).toMatchObject({
      fromMode: 'full_legacy',
      toMode: 'cashless',
      bySupport: false,
      reason: null,
    });
    const audit = await ds.query<{ action: string }[]>(
      `SELECT action FROM admin_audit_logs WHERE organization_id = $1`,
      [id],
    );
    expect(audit).toEqual([{ action: 'set_operating_mode' }]);
    expect(gateway.notifyOrganizationSettingsUpdated).toHaveBeenCalledWith(id);

    await expect(modes.setByMember(id, 'full', admin)).rejects.toMatchObject({
      response: { code: 'TSE_REQUIRED_FOR_CASH' },
    });
    tseStatus.isActive = () => true;
    await expect(modes.setByMember(id, 'full', admin)).resolves.toMatchObject({
      operatingMode: 'full',
      cashAllowed: true,
    });
  });

  it('the support switches with reason; the certificate renders from the real history', async () => {
    const id = await org('DE', 'cashless', false);
    await modes.adminSetMode(
      id,
      'orders_only',
      'Antrag per E-Mail',
      superAdmin,
    );
    const { pdf } = await modes.certificatePdf(id, admin);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const view = await modes.getForMember(id, admin);
    expect(view.history[0]).toMatchObject({
      changedByName: 'OpenEOS-Support',
      reason: 'Antrag per E-Mail',
    });
  });

  it('the country is set once by the club, then only by the support', async () => {
    const id = await org(null);
    await expect(
      modes.setByMember(id, 'cashless', admin),
    ).rejects.toMatchObject({ response: { reason: 'COUNTRY_REQUIRED' } });
    await countries.setCountryOnce(id, 'at', admin);
    await expect(
      countries.setCountryOnce(id, 'DE', admin),
    ).rejects.toMatchObject({ response: { reason: 'COUNTRY_ALREADY_SET' } });
    await countries.adminSetCountry(id, 'CH', 'Sitz in Basel', superAdmin);
    const history = await countries.history(id);
    expect(history.map((h) => h.toValue)).toEqual(['CH', 'AT']);
    expect((await modes.stateOf(id)).country).toBe('CH');
  });
});
