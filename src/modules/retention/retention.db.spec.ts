import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { CronLockService } from '../../common/redis/cron-lock.service';
import { RetentionRun } from '../../database/entities';
import type { MenuImportWorkerService } from '../assistant/menu-import/menu-import-worker.service';
import type { EmailService } from '../email/email.service';
import { rowsOf } from '../tse/tse-sql.util';
import { AssistantImportsJob } from './jobs/assistant-imports.job';
import { AuditLogsJob } from './jobs/audit-logs.job';
import { AuthRecordsJob } from './jobs/auth-records.job';
import { ContactRequestsJob } from './jobs/contact-requests.job';
import { FiscalArchiveJob } from './jobs/fiscal-archive.job';
import { GuestDataJob } from './jobs/guest-data.job';
import { HelperDataJob } from './jobs/helper-data.job';
import { OrganizationInactivityJob } from './jobs/organization-inactivity.job';
import { OrganizationPurgeJob } from './jobs/organization-purge.job';
import { SupportMessagesJob } from './jobs/support-messages.job';
import { UserAccountsJob } from './jobs/user-accounts.job';
import { loadRetentionConfig } from './retention.config';
import { RetentionErasureService } from './retention-erasure.service';
import { AccountDeletionService } from './account-deletion.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { OrganizationClosureService } from '../../common/organization-closure/organization-closure.service';
import type { ConfigService } from '@nestjs/config';
import { RetentionNoticeService } from './retention-notice.service';
import { RetentionService } from './retention.service';
import type { RetentionCategory } from './retention.types';

/**
 * Loeschlaeufe gegen ein echtes Postgres: was geloescht bzw. anonymisiert
 * wird, was bleibt, dass das Steuerarchiv unberuehrt bleibt, die Regel
 * „erst 30 Tage nach dem Exportangebot“ und der Probelauf. Nur mit
 * Wegwerf-Datenbank, z. B.
 *
 *   TEST_RETENTION_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:55481/openeos_retention_scratch pnpm test retention.db
 *
 * Name muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_RETENTION_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

/** Zeilen als Text gelesen; Zahlen/JSON nur in einzelnen Erwartungen. */
type Row = Record<string, string>;

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number, from = new Date()) =>
  new Date(from.getTime() - days * DAY);
const later = (days: number, from = new Date()) =>
  new Date(from.getTime() + days * DAY);

describeWithDb('Retention jobs against Postgres', () => {
  let ds: DataSource;
  let service: RetentionService;
  let erasure: RetentionErasureService;
  let deletion: AccountDeletionService;
  let closures: OrganizationClosureService;
  let encryption: EncryptionService;
  let uploadDir: string;
  const sent: { to: string; subject: string; text?: string }[] = [];
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const contactIds: string[] = [];
  const suiteStart = new Date();
  const cleanupNow = jest.fn(() =>
    Promise.resolve({ filesDeleted: 2, importsDeleted: 1 }),
  );

  const sql = async (text: string, params: unknown[] = []): Promise<Row[]> =>
    rowsOf<Row>(await ds.query(text, params));
  const one = async (text: string, params: unknown[] = []): Promise<Row> =>
    (await sql(text, params))[0];

  const run = async (
    category: RetentionCategory,
    options: { dryRun?: boolean; now?: Date } = {},
  ): Promise<RetentionRun> => {
    const [result] = await service.runAll(
      { trigger: 'manual', dryRun: options.dryRun ?? false, now: options.now },
      [category],
    );
    expect(result.status).toBe('succeeded');
    return result;
  };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name))
      throw new Error(`Database "${name}" does not end in _test/_scratch`);
    ds = new DataSource({
      type: 'postgres',
      url: TEST_DB,
      entities: [path.join(__dirname, '../../database/entities/*.entity.ts')],
      migrations: [path.join(__dirname, '../../database/migrations/*.ts')],
      migrationsRun: true,
      logging: false,
    });
    await ds.initialize();
    uploadDir = mkdtempSync(path.join(tmpdir(), 'retention-'));

    const config = loadRetentionConfig({ RETENTION_DRY_RUN: 'false' });
    const email = {
      appUrl: 'https://app.example.test',
      sendEmail: (o: { to: string; subject: string; text?: string }) => {
        sent.push({ to: o.to, subject: o.subject, text: o.text });
        return Promise.resolve(true);
      },
    } as unknown as EmailService;
    const notices = new RetentionNoticeService(email);
    const options = {
      uploadDir,
      fiscalExportDir: path.join(uploadDir, 'tse-exports'),
      contactEmail: 'export@example.test',
    };
    const jobs = [
      new GuestDataJob(),
      new HelperDataJob(),
      new AuthRecordsJob(),
      new AuditLogsJob(),
      new SupportMessagesJob(),
      new ContactRequestsJob(),
      new AssistantImportsJob({
        cleanupNow,
      } as unknown as MenuImportWorkerService),
      new OrganizationInactivityJob(notices),
      new OrganizationPurgeJob(notices, options),
      new UserAccountsJob(notices, options),
      new FiscalArchiveJob(),
    ];
    service = new RetentionService(
      ds,
      ds.getRepository(RetentionRun),
      config,
      jobs,
      {
        runExclusive: async (_n: string, job: () => Promise<void>) => {
          await job();
          return true;
        },
      } as unknown as CronLockService,
    );
    erasure = new RetentionErasureService(service, notices, jobs);
    encryption = new EncryptionService({
      get: (key: string, fallback?: string) =>
        key === 'TWO_FACTOR_ENCRYPTION_KEY'
          ? 'a'.repeat(64)
          : (fallback ?? undefined),
    } as unknown as ConfigService);
    deletion = new AccountDeletionService(service, notices, encryption, jobs);
    closures = new OrganizationClosureService(ds);
  }, 120_000);

  afterAll(async () => {
    if (ds?.isInitialized) {
      if (orgIds.length) {
        await sql(
          `ALTER TABLE cash_point_closings DISABLE TRIGGER cash_point_closings_immutable`,
        );
        for (const table of [
          'cashbook_entries',
          'cash_point_closings',
          'tse_exports',
          'tse_outages',
          'tse_transactions',
          'tse_units',
          'cash_registers',
        ]) {
          await sql(
            `DELETE FROM ${table} WHERE organization_id = ANY($1::uuid[])`,
            [orgIds],
          );
        }
        await sql(
          `ALTER TABLE cash_point_closings ENABLE TRIGGER cash_point_closings_immutable`,
        );
        await sql(
          `DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE organization_id = ANY($1::uuid[]))`,
          [orgIds],
        );
        await sql(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
          orgIds,
        ]);
      }
      const subjects = [...orgIds, ...userIds];
      await sql(
        `DELETE FROM retention_notices WHERE subject_id = ANY($1::uuid[])`,
        [subjects],
      );
      await sql(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
      await sql(`DELETE FROM contact_requests WHERE id = ANY($1::uuid[])`, [
        contactIds,
      ]);
      await sql(`DELETE FROM retention_runs WHERE created_at >= $1`, [
        suiteStart,
      ]);
      await ds.destroy();
    }
    rmSync(uploadDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- Fixtures

  async function org(
    o: { createdAt?: Date; deletedAt?: Date | null; name?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    orgIds.push(id);
    await sql(
      `INSERT INTO organizations (id, name, slug, support_pin, settings, billing_email, created_at, deleted_at)
       VALUES ($1, $2, $3, '123456', $4, 'kasse@verein.example', $5, $6)`,
      [
        id,
        o.name ?? 'TSV Musterdorf e. V.',
        `tsv-${id}`,
        JSON.stringify({
          currency: 'EUR',
          timezone: 'Europe/Berlin',
          locale: 'de',
          taxNumber: '12/345/67890',
          contact: {
            address: 'Sportplatzweg 1',
            zipCode: '12345',
            city: 'Musterdorf',
            email: 'vorstand@verein.example',
            phone: '0123 456',
          },
          sumup: { apiKey: 'secret', merchantCode: 'M1' },
          legal: { contactEmail: 'datenschutz@verein.example' },
        }),
        o.createdAt ?? new Date(),
        o.deletedAt ?? null,
      ],
    );
    return id;
  }

  async function user(
    o: { createdAt?: Date; lastLoginAt?: Date | null } = {},
  ): Promise<string> {
    const id = randomUUID();
    userIds.push(id);
    await sql(
      `INSERT INTO users (id, email, first_name, last_name, password_hash, created_at, last_login_at)
       VALUES ($1, $2, 'Erika', 'Muster', 'hash', $3, $4)`,
      [
        id,
        `erika-${id}@example.test`,
        o.createdAt ?? new Date(),
        o.lastLoginAt ?? null,
      ],
    );
    return id;
  }

  async function member(
    userId: string,
    organizationId: string,
    role: 'admin' | 'member' = 'admin',
  ) {
    await sql(
      `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, $3)`,
      [userId, organizationId, role],
    );
  }

  async function event(
    organizationId: string,
    o: { endDate?: Date | null; createdAt?: Date } = {},
  ): Promise<{ eventId: string; productId: string; categoryId: string }> {
    const created = o.createdAt ?? o.endDate ?? new Date();
    const [{ id: eventId }] = await sql(
      `INSERT INTO events (organization_id, name, start_date, end_date, created_at, description, settings)
       VALUES ($1, 'Sommerfest', $2, $2, $3, 'Beschreibung', '{"shop": {"enabled": true}}') RETURNING id`,
      [organizationId, o.endDate ?? null, created],
    );
    const [{ id: categoryId }] = await sql(
      `INSERT INTO categories (event_id, name) VALUES ($1, 'Getränke') RETURNING id`,
      [eventId],
    );
    const [{ id: productId }] = await sql(
      `INSERT INTO products (event_id, category_id, name, price) VALUES ($1, $2, 'Apfelschorle', 2.5) RETURNING id`,
      [eventId, categoryId],
    );
    return { eventId, productId, categoryId };
  }

  async function order(
    organizationId: string,
    ev: { eventId: string; productId: string; categoryId: string } | null,
    o: {
      createdAt?: Date;
      status?: string;
      source?: string;
      notes?: string;
    } = {},
  ): Promise<string> {
    const [{ id }] = await sql(
      `INSERT INTO orders (organization_id, event_id, order_number, daily_number, customer_name,
                           customer_phone, notes, status, source, total, created_at)
       VALUES ($1, $2, $3, 1, 'Max Gast', '0170 1234', $4, $5, $6, 2.5, $7) RETURNING id`,
      [
        organizationId,
        ev?.eventId ?? null,
        `A-${randomUUID().slice(0, 8)}`,
        o.notes ?? 'Shop-Bestellung · max@gast.example',
        o.status ?? 'completed',
        o.source ?? 'online',
        o.createdAt ?? new Date(),
      ],
    );
    if (ev) {
      await sql(
        `INSERT INTO order_items (order_id, product_id, category_id, product_name, category_name,
                                  quantity, unit_price, total_price, tax_rate, notes)
         VALUES ($1, $2, $3, 'Apfelschorle', 'Getränke', 1, 2.5, 2.5, 19, 'für Max')`,
        [id, ev.productId, ev.categoryId],
      );
    }
    return id;
  }

  /** Cloud-TSE mit einem signierten, abgeschlossenen Vorgang zu `orderId`. */
  async function fiscal(
    organizationId: string,
    orderId: string | null,
    o: {
      unitState?: string;
      deactivatedAt?: Date | null;
      closed?: boolean;
      createdAt?: Date;
    } = {},
  ): Promise<{ txId: string; closingId: string | null }> {
    const [{ id: unitId }] = await sql(
      `INSERT INTO tse_units (organization_id, trigger, client_id, product_type, state, deactivated_at)
       VALUES ($1, 'manual', 'OEOS-TEST', 'cloud', $2, $3) RETURNING id`,
      [
        organizationId,
        o.unitState ?? 'deactivated',
        o.deactivatedAt ?? ago(60),
      ],
    );
    let closingId: string | null = null;
    if (o.closed !== false) {
      const [closing] = await sql(
        `INSERT INTO cash_point_closings (organization_id, register_id, z_nr, business_date, period_to,
            closing_created_at, trigger, totals, master_data, rows, content_sha256, created_by_user_id)
         VALUES ($1, 'OEOS-TEST', (SELECT COALESCE(max(z_nr), 0) + 1 FROM cash_point_closings WHERE organization_id = $1),
                 $2::date, $2, $2, 'scheduled', '{"sum": 2.5}', '{"company": {"name": "TSV"}}',
                 '{"bediener": [{"BEDIENER_NAME": "Erika Muster"}]}', $3, NULL)
         RETURNING id`,
        [organizationId, o.createdAt ?? ago(50), 'f'.repeat(64)],
      );
      closingId = closing.id;
    }
    const [{ id: txId }] = await sql(
      `INSERT INTO tse_transactions (organization_id, tse_unit_id, kind, process_type, process_data, status,
          client_id, signature_value, amount, order_id, cash_point_closing_id, created_at)
       VALUES ($1, $2, 'receipt', 'Kassenbeleg-V1', 'Beleg^2.50_0.00_0.00_0.00_0.00^2.50:Bar', 'signed',
               'OEOS-TEST', 'c2lnbmF0dXI=', 2.5, $3, $4, $5) RETURNING id`,
      [organizationId, unitId, orderId, closingId, o.createdAt ?? ago(50)],
    );
    await sql(
      `INSERT INTO cashbook_entries (organization_id, business_date, type, amount, tse_transaction_id)
       VALUES ($1, $2::date, 'deposit', 50, $3)`,
      [organizationId, o.createdAt ?? ago(50), txId],
    );
    return { txId, closingId };
  }

  async function fiscalSnapshot(organizationId: string): Promise<string> {
    const rows = await sql(
      `SELECT
         (SELECT json_agg(t ORDER BY t.id) FROM (SELECT id, order_id, process_data, signature_value, amount, bon_id,
                 cash_point_closing_id FROM tse_transactions WHERE organization_id = $1) t) AS tx,
         (SELECT json_agg(c ORDER BY c.id) FROM (SELECT id, z_nr, rows, totals, master_data, content_sha256
                 FROM cash_point_closings WHERE organization_id = $1) c) AS closings,
         (SELECT json_agg(b ORDER BY b.id) FROM (SELECT id, amount, tse_transaction_id
                 FROM cashbook_entries WHERE organization_id = $1) b) AS cashbook,
         (SELECT json_agg(u ORDER BY u.id) FROM (SELECT id, state FROM tse_units WHERE organization_id = $1) u) AS units`,
      [organizationId],
    );
    return JSON.stringify(rows[0]);
  }

  // --------------------------------------------------------------- Gaeste

  describe('guest_data', () => {
    it('anonymises guest details 30 days after the event, keeps orders and fiscal records', async () => {
      const orgId = await org();
      const past = await event(orgId, { endDate: ago(40) });
      const recent = await event(orgId, { endDate: ago(10) });
      const oldOrder = await order(orgId, past, { createdAt: ago(41) });
      const recentOrder = await order(orgId, recent, { createdAt: ago(11) });
      const openNoEvent = await order(orgId, null, {
        createdAt: ago(60),
        status: 'open',
        source: 'pos',
      });
      await fiscal(orgId, oldOrder);
      const before = await fiscalSnapshot(orgId);
      const [checkout] = await sql(
        `INSERT INTO shop_checkouts (organization_id, event_id, email, customer_name, items, total_amount, order_id, created_at)
         VALUES ($1, $2, 'max@gast.example', '{"firstName": "Max"}', '[]', 2.5, $3, $4) RETURNING id`,
        [orgId, past.eventId, oldOrder, ago(41)],
      );
      const [qr] = await sql(
        `INSERT INTO qr_codes (organization_id, code, type) VALUES ($1, $2, 'table') RETURNING id`,
        [orgId, `qr-${randomUUID()}`],
      );
      const [session] = await sql(
        `INSERT INTO online_order_sessions (organization_id, qr_code_id, session_token, customer_name, expires_at, created_at)
         VALUES ($1, $2, $3, 'Max', $4, $4) RETURNING id`,
        [orgId, qr.id, randomUUID(), ago(40)],
      );
      const [printer] = await sql(
        `INSERT INTO printers (organization_id, name, connection_type, type) VALUES ($1, 'Bon', 'network', 'receipt') RETURNING id`,
        [orgId],
      );
      const [job] = await sql(
        `INSERT INTO print_jobs (organization_id, printer_id, order_id, status, payload, created_at)
         VALUES ($1, $2, $3, 'completed', '{"data": {"customer_name": "Max"}}', $4) RETURNING id`,
        [orgId, printer.id, oldOrder, ago(40)],
      );

      const result = await run('guest_data');

      const anonymised = await one(
        `SELECT customer_name, customer_phone, notes, total FROM orders WHERE id = $1`,
        [oldOrder],
      );
      expect(anonymised).toMatchObject({
        customer_name: null,
        customer_phone: null,
        notes: null,
      });
      expect(Number(anonymised.total)).toBe(2.5);
      expect(
        (
          await one(`SELECT notes FROM order_items WHERE order_id = $1`, [
            oldOrder,
          ])
        ).notes,
      ).toBeNull();
      expect(
        await one(`SELECT customer_name FROM orders WHERE id = $1`, [
          recentOrder,
        ]),
      ).toEqual({ customer_name: 'Max Gast' });
      expect(
        await one(`SELECT customer_name FROM orders WHERE id = $1`, [
          openNoEvent,
        ]),
      ).toEqual({ customer_name: 'Max Gast' });
      expect(
        await one(
          `SELECT email, customer_name FROM shop_checkouts WHERE id = $1`,
          [checkout.id],
        ),
      ).toEqual({ email: '', customer_name: null });
      expect(
        await sql(`SELECT 1 FROM online_order_sessions WHERE id = $1`, [
          session.id,
        ]),
      ).toHaveLength(0);
      expect(
        await sql(`SELECT 1 FROM print_jobs WHERE id = $1`, [job.id]),
      ).toHaveLength(0);
      expect(await fiscalSnapshot(orgId)).toBe(before);
      expect(result.counts.ordersAnonymised).toBeGreaterThanOrEqual(1);
      expect(result.total).toBeGreaterThanOrEqual(4);
    });

    it('dry run counts the same but changes nothing', async () => {
      const orgId = await org();
      const past = await event(orgId, { endDate: ago(40) });
      const orderId = await order(orgId, past, { createdAt: ago(41) });

      const dry = await run('guest_data', { dryRun: true });

      expect(dry.dryRun).toBe(true);
      expect(dry.counts.ordersAnonymised).toBeGreaterThanOrEqual(1);
      expect(
        await one(`SELECT customer_name FROM orders WHERE id = $1`, [orderId]),
      ).toEqual({ customer_name: 'Max Gast' });
      const stored = await one(
        `SELECT dry_run, status, counts FROM retention_runs WHERE id = $1`,
        [dry.id],
      );
      expect(stored.dry_run).toBe(true);
      expect(stored.status).toBe('succeeded');
      expect(
        (stored.counts as unknown as Record<string, number>).ordersAnonymised,
      ).toBe(dry.counts.ordersAnonymised);
    });
  });

  // ---------------------------------------------------------------- Helfer

  describe('helper_data', () => {
    async function plan(organizationId: string, shiftDay: Date) {
      const [p] = await sql(
        `INSERT INTO shift_plans (organization_id, name, public_slug) VALUES ($1, 'Helfer', $2) RETURNING id`,
        [organizationId, `plan-${randomUUID()}`],
      );
      const [j] = await sql(
        `INSERT INTO shift_jobs (shift_plan_id, name) VALUES ($1, 'Grill') RETURNING id`,
        [p.id],
      );
      const [s] = await sql(
        `INSERT INTO shifts (shift_job_id, date, start_time, end_time) VALUES ($1, $2::date, '10:00', '14:00') RETURNING id`,
        [j.id, shiftDay],
      );
      const [r] = await sql(
        `INSERT INTO shift_registrations (shift_id, registration_group_id, name, email, phone, notes, verification_token)
         VALUES ($1, $2, 'Hanna Helfer', 'hanna@example.test', '0171', 'vegetarisch', $3) RETURNING id`,
        [s.id, randomUUID(), randomUUID().replace(/-/g, '')],
      );
      await sql(
        `INSERT INTO helper_magic_links (token, shift_plan_id, email, expires_at)
         VALUES ($1, $2, 'hanna@example.test', $3)`,
        [randomUUID().replace(/-/g, ''), p.id, later(1)],
      );
      return { planId: p.id, registrationId: r.id };
    }

    it('deletes registrations 30 days after the last shift and keeps the plan', async () => {
      const orgId = await org();
      const old = await plan(orgId, ago(40));
      const current = await plan(orgId, ago(5));

      const result = await run('helper_data');

      expect(
        await sql(`SELECT 1 FROM shift_registrations WHERE id = $1`, [
          old.registrationId,
        ]),
      ).toHaveLength(0);
      expect(
        await sql(`SELECT 1 FROM helper_magic_links WHERE shift_plan_id = $1`, [
          old.planId,
        ]),
      ).toHaveLength(0);
      expect(
        await sql(`SELECT 1 FROM shift_plans WHERE id = $1`, [old.planId]),
      ).toHaveLength(1);
      expect(
        await sql(`SELECT 1 FROM shift_registrations WHERE id = $1`, [
          current.registrationId,
        ]),
      ).toHaveLength(1);
      expect(result.counts.registrationsDeleted).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------- Anmeldedaten

  describe('auth_records', () => {
    it('removes expired sessions, codes, links and stale tokens, keeps valid ones', async () => {
      const orgId = await org();
      const userId = await user();
      await sql(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address) VALUES
           ($1, 'expired', $2, '203.0.113.1'), ($1, 'valid', $3, '203.0.113.1')`,
        [userId, ago(3), later(5)],
      );
      await sql(
        `INSERT INTO email_otps (user_id, code_hash, purpose, expires_at) VALUES ($1, 'x', 'two_factor_login', $2)`,
        [userId, ago(2)],
      );
      await sql(
        `INSERT INTO login_magic_links (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
        [userId, randomUUID(), ago(2)],
      );
      await sql(
        `INSERT INTO trusted_devices (user_id, device_fingerprint, expires_at) VALUES ($1, 'fp', $2)`,
        [userId, ago(1)],
      );
      await sql(
        `INSERT INTO api_tokens (name, token_hash, token_prefix, user_id, organization_id, revoked_at) VALUES
           ('alt', $2, 'oe_a', $1, $3, $4), ('aktiv', $5, 'oe_b', $1, $3, NULL)`,
        [userId, randomUUID(), orgId, ago(100), randomUUID()],
      );

      await run('auth_records');

      expect(
        (
          await sql(
            `SELECT token_hash FROM refresh_tokens WHERE user_id = $1`,
            [userId],
          )
        ).map((r) => r.token_hash),
      ).toEqual(['valid']);
      for (const table of [
        'email_otps',
        'login_magic_links',
        'trusted_devices',
      ]) {
        expect(
          await sql(`SELECT 1 FROM ${table} WHERE user_id = $1`, [userId]),
        ).toHaveLength(0);
      }
      expect(
        (
          await sql(`SELECT name FROM api_tokens WHERE user_id = $1`, [userId])
        ).map((r) => r.name),
      ).toEqual(['aktiv']);
    });
  });

  // ------------------------------------------------------------ Protokolle

  describe('audit_logs', () => {
    it('deletes old entries, pseudonymises evidence entries, keeps recent ones', async () => {
      const orgId = await org();
      const insert = async (action: string, createdAt: Date) =>
        (
          await one(
            `INSERT INTO admin_audit_logs (organization_id, action, resource_type, ip_address, user_agent, created_at)
             VALUES ($1, $2, 'organization', '203.0.113.9', 'Firefox', $3) RETURNING id`,
            [orgId, action, createdAt],
          )
        ).id;
      const oldView = await insert('view_organization', ago(100));
      const oldBilling = await insert('event_checkout_released', ago(100));
      const recent = await insert('view_organization', ago(10));
      await sql(
        `INSERT INTO organization_cash_policy_changes (organization_id, kind, to_value, changed_by_name, ip_address, user_agent, created_at)
         VALUES ($1, 'cash_policy', 'tse', 'Erika Muster', '203.0.113.9', 'Firefox', $2)`,
        [orgId, ago(100)],
      );

      await run('audit_logs');

      expect(
        await sql(`SELECT 1 FROM admin_audit_logs WHERE id = $1`, [oldView]),
      ).toHaveLength(0);
      expect(
        await one(
          `SELECT ip_address, user_agent FROM admin_audit_logs WHERE id = $1`,
          [oldBilling],
        ),
      ).toEqual({ ip_address: 'removed', user_agent: null });
      expect(
        await one(`SELECT ip_address FROM admin_audit_logs WHERE id = $1`, [
          recent,
        ]),
      ).toEqual({ ip_address: '203.0.113.9' });
      expect(
        await one(
          `SELECT ip_address, user_agent, changed_by_name FROM organization_cash_policy_changes WHERE organization_id = $1`,
          [orgId],
        ),
      ).toEqual({
        ip_address: null,
        user_agent: null,
        changed_by_name: 'Erika Muster',
      });
    });
  });

  // ------------------------------------------------- Support und Kontakt

  describe('support_messages and contact_requests', () => {
    it('deletes support chats 12 months after the last use, keeps active customers', async () => {
      const idle = await org({ createdAt: ago(800) });
      const active = await org({ createdAt: ago(800) });
      await event(active, { endDate: ago(20) });
      for (const organizationId of [idle, active]) {
        await sql(
          `INSERT INTO support_messages (organization_id, direction, body, created_at) VALUES ($1, 'inbound', 'Hilfe', $2)`,
          [organizationId, ago(400)],
        );
      }

      await run('support_messages');

      expect(
        await sql(`SELECT 1 FROM support_messages WHERE organization_id = $1`, [
          idle,
        ]),
      ).toHaveLength(0);
      expect(
        await sql(`SELECT 1 FROM support_messages WHERE organization_id = $1`, [
          active,
        ]),
      ).toHaveLength(1);
    });

    it('deletes enquiries 6 months after they were handled', async () => {
      const insert = async (handledAt: Date | null, createdAt: Date) => {
        const [row] = await sql(
          `INSERT INTO contact_requests (type, name, email, message, handled_at, created_at)
           VALUES ('contact', 'Interessent', 'i@example.test', 'Frage', $1, $2) RETURNING id`,
          [handledAt, createdAt],
        );
        contactIds.push(row.id);
        return row.id;
      };
      const oldHandled = await insert(ago(200), ago(210));
      const recentHandled = await insert(ago(30), ago(40));
      const unhandled = await insert(null, ago(700));

      await run('contact_requests');

      const left = (
        await sql(
          `SELECT id FROM contact_requests WHERE id = ANY($1::uuid[])`,
          [[oldHandled, recentHandled, unhandled]],
        )
      ).map((r) => r.id);
      expect(left.sort()).toEqual([recentHandled, unhandled].sort());
    });
  });

  // -------------------------------------------------------- Assistent

  describe('assistant_imports', () => {
    it('delegates to the import worker and protocols its counts', async () => {
      const result = await run('assistant_imports');
      expect(cleanupNow).toHaveBeenCalled();
      expect(result.counts).toEqual({
        uploadFoldersDeleted: 2,
        importsDeleted: 1,
      });
    });
  });

  // ---------------------------------------------- Organisationen: Inaktivitaet

  describe('organization_inactivity', () => {
    it('announces after 24 months, closes no earlier than 30 days later', async () => {
      const orgId = await org({ createdAt: ago(800) });
      const adminId = await user();
      await member(adminId, orgId);
      const activeOrg = await org({ createdAt: ago(800) });
      await event(activeOrg, { endDate: ago(100) });
      sent.length = 0;

      const first = await run('organization_inactivity');
      expect(first.counts.noticesSent).toBeGreaterThanOrEqual(1);
      expect(sent.map((m) => m.to)).toContain(`erika-${adminId}@example.test`);
      expect(sent[0].subject).toContain('wird geschlossen');
      const notice = await one(
        `SELECT due_at FROM retention_notices WHERE subject_id = $1 AND kind = 'organization_inactivity'`,
        [orgId],
      );
      expect(new Date(notice.due_at).getTime()).toBeGreaterThan(
        later(29).getTime(),
      );
      expect(
        await sql(`SELECT 1 FROM retention_notices WHERE subject_id = $1`, [
          activeOrg,
        ]),
      ).toHaveLength(0);

      // Gleich danach: weder geschlossen noch erneut angekuendigt.
      sent.length = 0;
      await run('organization_inactivity');
      expect(sent.filter((m) => m.to.includes(adminId))).toHaveLength(0);
      expect(
        (
          await one(`SELECT deleted_at FROM organizations WHERE id = $1`, [
            orgId,
          ])
        ).deleted_at,
      ).toBeNull();

      // 31 Tage spaeter: geschlossen.
      const closed = await run('organization_inactivity', { now: later(31) });
      expect(closed.counts.organizationsClosed).toBeGreaterThanOrEqual(1);
      expect(
        (
          await one(`SELECT deleted_at FROM organizations WHERE id = $1`, [
            orgId,
          ])
        ).deleted_at,
      ).not.toBeNull();
    });

    it('drops the notice when the organization is used again, and on "keep"', async () => {
      const usedAgain = await org({ createdAt: ago(800) });
      const kept = await org({ createdAt: ago(800) });
      await run('organization_inactivity');
      await event(usedAgain, { endDate: later(10), createdAt: new Date() });
      await service.keep('organization', kept);

      await run('organization_inactivity', { now: later(31) });

      expect(
        (
          await one(
            `SELECT cancel_reason FROM retention_notices WHERE subject_id = $1`,
            [usedAgain],
          )
        ).cancel_reason,
      ).toBe('activity');
      expect(
        await sql(
          `SELECT cancel_reason FROM retention_notices WHERE subject_id = $1`,
          [kept],
        ),
      ).toEqual([{ cancel_reason: 'kept' }]);
      const closed = await sql(
        `SELECT id FROM organizations WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL`,
        [[usedAgain, kept]],
      );
      expect(closed).toHaveLength(0);
    });
  });

  // ------------------------------------------ Organisationen: endgueltig loeschen

  describe('organization_purge', () => {
    it('never purges without an export offer at least 30 days old', async () => {
      // Seit zwei Jahren geloescht, aber nie angekuendigt.
      const orgId = await org({ deletedAt: ago(730), createdAt: ago(900) });
      const adminId = await user();
      await member(adminId, orgId);
      const ev = await event(orgId, { endDate: ago(800) });
      const orderId = await order(orgId, ev, { createdAt: ago(800) });
      sent.length = 0;

      const first = await run('organization_purge');
      expect(first.counts.noticesSent).toBeGreaterThanOrEqual(1);
      expect(first.counts.organizationsPurged ?? 0).toBe(0);
      expect(sent.find((m) => m.to.includes(adminId))?.subject).toContain(
        'Endgültige Löschung',
      );
      expect(
        await sql(`SELECT 1 FROM orders WHERE id = $1`, [orderId]),
      ).toHaveLength(1);

      // 29 Tage spaeter: immer noch nicht.
      await run('organization_purge', { now: later(29) });
      expect(
        await sql(`SELECT 1 FROM orders WHERE id = $1`, [orderId]),
      ).toHaveLength(1);

      // 31 Tage spaeter: geloescht.
      const purged = await run('organization_purge', { now: later(31) });
      expect(purged.counts.organizationsPurged).toBeGreaterThanOrEqual(1);
      expect(
        await sql(`SELECT 1 FROM orders WHERE id = $1`, [orderId]),
      ).toHaveLength(0);
    });

    it('purges customer data but keeps the fiscal archive and the orders it references', async () => {
      const orgId = await org({ deletedAt: ago(40), createdAt: ago(400) });
      const adminId = await user();
      await member(adminId, orgId);
      const ev = await event(orgId, { endDate: ago(45) });
      const fiscalOrder = await order(orgId, ev, { createdAt: ago(45) });
      const plainOrder = await order(orgId, ev, { createdAt: ago(45) });
      await fiscal(orgId, fiscalOrder);
      await sql(
        `INSERT INTO shift_plans (organization_id, name, public_slug) VALUES ($1, 'Helfer', $2)`,
        [orgId, `plan-${randomUUID()}`],
      );
      const productDir = path.join(uploadDir, orgId, 'product');
      mkdirSync(productDir, { recursive: true });
      writeFileSync(path.join(productDir, 'bild.jpg'), 'x');
      const exportDir = path.join(uploadDir, 'tse-exports', orgId);
      mkdirSync(exportDir, { recursive: true });
      writeFileSync(path.join(exportDir, 'export.tar'), 'tar');
      const before = await fiscalSnapshot(orgId);

      await run('organization_purge'); // Ankuendigung
      const purged = await run('organization_purge', { now: later(31) });

      expect(purged.counts.organizationsPurged).toBeGreaterThanOrEqual(1);
      expect(await fiscalSnapshot(orgId)).toBe(before);
      expect(
        await one(
          `SELECT customer_name, customer_phone, notes FROM orders WHERE id = $1`,
          [fiscalOrder],
        ),
      ).toEqual({ customer_name: null, customer_phone: null, notes: null });
      expect(
        await sql(`SELECT 1 FROM orders WHERE id = $1`, [plainOrder]),
      ).toHaveLength(0);
      expect(
        await sql(`SELECT 1 FROM shift_plans WHERE organization_id = $1`, [
          orgId,
        ]),
      ).toHaveLength(0);
      expect(
        await sql(
          `SELECT 1 FROM user_organizations WHERE organization_id = $1`,
          [orgId],
        ),
      ).toHaveLength(0);
      expect(
        await sql(`SELECT 1 FROM events WHERE organization_id = $1`, [orgId]),
      ).toHaveLength(1);
      const shell = await one(
        `SELECT name, slug, billing_email, settings FROM organizations WHERE id = $1`,
        [orgId],
      );
      expect(shell.name).toBe('TSV Musterdorf e. V.');
      expect(shell.slug).toBe(`purged-${orgId}`);
      expect(shell.billing_email).toBeNull();
      expect(shell.settings).toEqual({
        currency: 'EUR',
        timezone: 'Europe/Berlin',
        locale: 'de',
        taxNumber: '12/345/67890',
        contact: {
          address: 'Sportplatzweg 1',
          zipCode: '12345',
          city: 'Musterdorf',
        },
      });
      expect(existsSync(productDir)).toBe(false);
      expect(existsSync(path.join(exportDir, 'export.tar'))).toBe(true);
    });

    it('waits while the TSE is live or transactions are not closed yet', async () => {
      const live = await org({ deletedAt: ago(40) });
      await fiscal(live, null, { unitState: 'active', deactivatedAt: null });
      const unclosed = await org({ deletedAt: ago(40) });
      await fiscal(unclosed, null, { closed: false });

      await run('organization_purge');
      const result = await run('organization_purge', { now: later(31) });

      expect(result.counts.skippedTseActive).toBeGreaterThanOrEqual(1);
      expect(result.counts.skippedUnclosedTransactions).toBeGreaterThanOrEqual(
        1,
      );
      for (const organizationId of [live, unclosed]) {
        expect(
          (
            await one(`SELECT slug FROM organizations WHERE id = $1`, [
              organizationId,
            ])
          ).slug,
        ).toBe(`tsv-${organizationId}`);
      }
    });

    it('cancels the announcement when the organization is restored', async () => {
      const orgId = await org({ deletedAt: ago(5) });
      await run('organization_purge');
      await sql(`UPDATE organizations SET deleted_at = NULL WHERE id = $1`, [
        orgId,
      ]);
      await run('organization_purge', { now: later(31) });
      expect(
        await one(
          `SELECT cancel_reason FROM retention_notices WHERE subject_id = $1`,
          [orgId],
        ),
      ).toEqual({ cancel_reason: 'restored' });
    });
  });

  // ------------------------------------------------------------ Benutzer

  describe('user_accounts', () => {
    it('announces and then anonymises idle accounts without an organization', async () => {
      const idle = await user({
        createdAt: ago(900),
        lastLoginAt: ago(800),
      });
      const withOrg = await user({
        createdAt: ago(900),
        lastLoginAt: ago(800),
      });
      await member(withOrg, await org());
      await sql(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, 'x', $2)`,
        [idle, later(5)],
      );
      sent.length = 0;

      await run('user_accounts');
      expect(sent.map((m) => m.to)).toContain(`erika-${idle}@example.test`);
      expect(sent.map((m) => m.to)).not.toContain(
        `erika-${withOrg}@example.test`,
      );

      await run('user_accounts', { now: later(31) });

      const gone = await one(
        `SELECT email, first_name, last_name, password_hash, is_active, deleted_at FROM users WHERE id = $1`,
        [idle],
      );
      expect(gone).toMatchObject({
        email: `deleted-${idle}@deleted.invalid`,
        first_name: 'Gelöschtes',
        last_name: 'Konto',
        password_hash: null,
        is_active: false,
      });
      expect(gone.deleted_at).not.toBeNull();
      expect(
        await sql(`SELECT 1 FROM refresh_tokens WHERE user_id = $1`, [idle]),
      ).toHaveLength(0);
      expect(
        (await one(`SELECT email FROM users WHERE id = $1`, [withOrg])).email,
      ).toBe(`erika-${withOrg}@example.test`);
    });

    it('a login after the notice keeps the account', async () => {
      const userId = await user({ createdAt: ago(900), lastLoginAt: ago(800) });
      await run('user_accounts');
      await sql(`UPDATE users SET last_login_at = now() WHERE id = $1`, [
        userId,
      ]);
      await run('user_accounts', { now: later(31) });
      expect(
        (await one(`SELECT email FROM users WHERE id = $1`, [userId])).email,
      ).toBe(`erika-${userId}@example.test`);
    });
  });

  // ------------------------------------------------------- Steuerarchiv

  describe('fiscal_archive', () => {
    it('reports records past the retention period but never deletes them', async () => {
      const orgId = await org();
      const { txId } = await fiscal(orgId, null, { createdAt: ago(12 * 366) });

      const result = await run('fiscal_archive');

      expect(result.total).toBe(0);
      expect(
        result.counts['pastRetention.tseTransactions'],
      ).toBeGreaterThanOrEqual(1);
      expect(
        await sql(`SELECT 1 FROM tse_transactions WHERE id = $1`, [txId]),
      ).toHaveLength(1);
    });
  });

  // ---------------------------------------------- Einzelloeschung auf Weisung

  describe('erasure on instruction', () => {
    it('anonymises one order and protocols executor and reason', async () => {
      const orgId = await org();
      const ev = await event(orgId, { endDate: ago(1) });
      const orderId = await order(orgId, ev);
      const other = await order(orgId, ev);
      const adminId = await user();

      const result = await erasure.erase({
        organizationId: orgId,
        kind: 'order',
        id: orderId,
        reason: 'Weisung per E-Mail vom 04.11.2026',
        executedByUserId: adminId,
      });

      expect(result.trigger).toBe('instruction');
      expect(result.counts.ordersAnonymised).toBe(1);
      expect(
        await one(`SELECT customer_name FROM orders WHERE id = $1`, [orderId]),
      ).toEqual({ customer_name: null });
      expect(
        await one(`SELECT customer_name FROM orders WHERE id = $1`, [other]),
      ).toEqual({ customer_name: 'Max Gast' });
      expect(
        await one(
          `SELECT executed_by_user_id, reason, organization_id FROM retention_runs WHERE id = $1`,
          [result.id],
        ),
      ).toEqual({
        executed_by_user_id: adminId,
        reason: 'Weisung per E-Mail vom 04.11.2026',
        organization_id: orgId,
      });
    });

    it('deletes all registrations of a helper by e-mail', async () => {
      const orgId = await org();
      const [p] = await sql(
        `INSERT INTO shift_plans (organization_id, name, public_slug) VALUES ($1, 'Helfer', $2) RETURNING id`,
        [orgId, `plan-${randomUUID()}`],
      );
      const [j] = await sql(
        `INSERT INTO shift_jobs (shift_plan_id, name) VALUES ($1, 'Kasse') RETURNING id`,
        [p.id],
      );
      const [s] = await sql(
        `INSERT INTO shifts (shift_job_id, date, start_time, end_time) VALUES ($1, now()::date, '10:00', '12:00') RETURNING id`,
        [j.id],
      );
      for (const email of ['Hanna@Example.test', 'other@example.test']) {
        await sql(
          `INSERT INTO shift_registrations (shift_id, registration_group_id, name, email, verification_token)
           VALUES ($1, $2, 'Helfer', $3, $4)`,
          [s.id, randomUUID(), email, randomUUID().replace(/-/g, '')],
        );
      }

      const result = await erasure.erase({
        organizationId: orgId,
        kind: 'helper_email',
        email: 'hanna@example.test',
        reason: 'Weisung',
        executedByUserId: randomUUID(),
      });

      expect(result.counts.registrationsDeleted).toBe(1);
      expect(
        (
          await sql(
            `SELECT email FROM shift_registrations WHERE shift_id = $1`,
            [s.id],
          )
        ).map((r) => r.email),
      ).toEqual(['other@example.test']);
    });

    it('refuses records of another organization', async () => {
      const orgA = await org();
      const orgB = await org();
      const orderOfB = await order(orgB, null);
      await expect(
        erasure.erase({
          organizationId: orgA,
          kind: 'order',
          id: orderOfB,
          reason: 'Weisung',
          executedByUserId: randomUUID(),
        }),
      ).rejects.toThrow('Kein passender Datensatz');
    });
  });

  describe('read-only closure state', () => {
    it('reports closed organizations with their final deletion date', async () => {
      const open = await org();
      const closed = await org({ deletedAt: ago(5) });
      const map = await closures.closures([open, closed]);
      expect(map.has(open)).toBe(false);
      const c = map.get(closed)!;
      expect(c.readOnly).toBe(true);
      expect(c.purged).toBe(false);
      // Ohne Ankuendigung: Loeschzeitpunkt plus Exportfrist (30 Tage).
      expect(
        Math.round((c.finalDeletionAt.getTime() - c.closedAt.getTime()) / DAY),
      ).toBe(30);

      // Mit Ankuendigung: deren Termin.
      await run('organization_purge');
      const notice = await one(
        `SELECT due_at FROM retention_notices WHERE subject_id = $1 AND kind = 'organization_deletion'`,
        [closed],
      );
      expect((await closures.closure(closed))!.finalDeletionAt.getTime()).toBe(
        new Date(notice.due_at).getTime(),
      );
    });

    it('finds the organization of an event', async () => {
      const orgId = await org();
      const ev = await event(orgId);
      expect(await closures.organizationOfEvent(ev.eventId)).toBe(orgId);
      expect(await closures.organizationOfEvent('nope')).toBeNull();
    });
  });

  describe('immediate purge on request (super admin)', () => {
    it('refuses a wrong confirmation name', async () => {
      const orgId = await org({ name: 'SV Blau-Weiß' });
      await expect(
        erasure.purgeOrganization({
          organizationId: orgId,
          confirmName: 'SV Blau Weiss',
          reason: 'Löschverlangen per E-Mail vom 06.11.2026',
          executedByUserId: randomUUID(),
        }),
      ).rejects.toThrow('stimmt nicht');
      expect(
        await one(`SELECT deleted_at FROM organizations WHERE id = $1`, [
          orgId,
        ]),
      ).toEqual({ deleted_at: null });
    });

    it('closes and purges at once, keeps the fiscal archive, logs and confirms', async () => {
      const orgId = await org({ name: 'SV Sofort e. V.' });
      const adminId = await user();
      await member(adminId, orgId);
      const ev = await event(orgId, { endDate: ago(2) });
      const fiscalOrder = await order(orgId, ev, { createdAt: ago(2) });
      const plainOrder = await order(orgId, ev, { createdAt: ago(2) });
      await fiscal(orgId, fiscalOrder);
      const before = await fiscalSnapshot(orgId);
      const executor = randomUUID();
      sent.length = 0;

      const result = await erasure.purgeOrganization({
        organizationId: orgId,
        confirmName: '  SV Sofort e. V. ',
        reason: 'Löschverlangen per E-Mail vom 06.11.2026 (AVV 10.2)',
        executedByUserId: executor,
      });

      expect(result.status).toBe('succeeded');
      expect(result.trigger).toBe('instruction');
      expect(result.category).toBe('organization_purge');
      expect(result.counts.organizationsPurged).toBe(1);
      expect(result.counts.organizationsClosed).toBe(1);
      const logged = await one(
        `SELECT executed_by_user_id, reason, organization_id FROM retention_runs WHERE id = $1`,
        [result.id],
      );
      expect(logged).toEqual({
        executed_by_user_id: executor,
        reason: 'Löschverlangen per E-Mail vom 06.11.2026 (AVV 10.2)',
        organization_id: orgId,
      });
      expect(await fiscalSnapshot(orgId)).toBe(before);
      expect(
        await sql(`SELECT 1 FROM orders WHERE id = $1`, [plainOrder]),
      ).toHaveLength(0);
      expect(
        await sql(`SELECT 1 FROM orders WHERE id = $1`, [fiscalOrder]),
      ).toHaveLength(1);
      expect(
        await sql(
          `SELECT 1 FROM user_organizations WHERE organization_id = $1`,
          [orgId],
        ),
      ).toHaveLength(0);
      const shell = await one(
        `SELECT slug, deleted_at FROM organizations WHERE id = $1`,
        [orgId],
      );
      expect(shell.slug).toBe(`purged-${orgId}`);
      expect(shell.deleted_at).not.toBeNull();
      // Bestaetigung an den Administrator (vor dem Loeschen ermittelt).
      expect(sent.find((m) => m.to.includes(adminId))?.subject).toContain(
        'endgültig gelöscht',
      );
      // Ausgefuehrt vermerkt: kein zweites Ankuendigen, kein zweites Loeschen.
      expect((await closures.closure(orgId))!.purged).toBe(true);
      sent.length = 0;
      await run('organization_purge');
      expect(sent.filter((m) => m.subject.includes('SV Sofort'))).toHaveLength(
        0,
      );
      await expect(
        erasure.purgeOrganization({
          organizationId: orgId,
          confirmName: 'SV Sofort e. V.',
          reason: 'Noch einmal versucht',
          executedByUserId: executor,
        }),
      ).rejects.toThrow('bereits endgültig gelöscht');
    });

    it('refuses while the Cloud-TSE is active (same rules as the nightly purge)', async () => {
      const orgId = await org({ name: 'TSE aktiv', deletedAt: ago(3) });
      await fiscal(orgId, null, { unitState: 'active', deactivatedAt: null });
      await expect(
        erasure.purgeOrganization({
          organizationId: orgId,
          confirmName: 'TSE aktiv',
          reason: 'Löschverlangen per E-Mail',
          executedByUserId: randomUUID(),
        }),
      ).rejects.toThrow('Cloud-TSE');
      expect((await closures.closure(orgId))!.purged).toBe(false);
    });

    it('dry run changes nothing', async () => {
      const orgId = await org({ name: 'Nur zählen' });
      const ev = await event(orgId);
      const orderId = await order(orgId, ev);
      const result = await erasure.purgeOrganization({
        organizationId: orgId,
        confirmName: 'Nur zählen',
        reason: 'Probelauf vor dem Löschen',
        executedByUserId: randomUUID(),
        dryRun: true,
      });
      expect(result.dryRun).toBe(true);
      expect(result.counts.organizationsPurged).toBe(1);
      expect(
        await sql(`SELECT 1 FROM orders WHERE id = $1`, [orderId]),
      ).toHaveLength(1);
      expect(
        await one(`SELECT deleted_at FROM organizations WHERE id = $1`, [
          orgId,
        ]),
      ).toEqual({ deleted_at: null });
    });
  });

  describe('account deletion (self service)', () => {
    async function withPassword(userId: string, password: string) {
      await sql(`UPDATE users SET password_hash = $2 WHERE id = $1`, [
        userId,
        await bcrypt.hash(password, 4),
      ]);
    }

    it('blocks the last admin of an organization with other members', async () => {
      const orgId = await org({ name: 'Mit Mitgliedern' });
      const adminId = await user();
      const otherId = await user();
      await member(adminId, orgId, 'admin');
      await member(otherId, orgId, 'member');
      await withPassword(adminId, 'geheim123');

      const status = await deletion.status(adminId);
      expect(status.allowed).toBe(false);
      expect(status.blockers).toEqual([
        { organizationId: orgId, name: 'Mit Mitgliedern', reason: 'members' },
      ]);
      await expect(
        deletion.deleteAccount(adminId, { password: 'geheim123' }),
      ).rejects.toThrow('letzte Administrator');

      // Mit einem zweiten Admin ist der Weg frei.
      await sql(
        `UPDATE user_organizations SET role = 'admin' WHERE user_id = $1`,
        [otherId],
      );
      expect((await deletion.status(adminId)).allowed).toBe(true);
    });

    it('blocks the last admin while an event is active', async () => {
      const orgId = await org({ name: 'Fest läuft' });
      const adminId = await user();
      await member(adminId, orgId);
      const ev = await event(orgId);
      await sql(`UPDATE events SET status = 'active' WHERE id = $1`, [
        ev.eventId,
      ]);
      const status = await deletion.status(adminId);
      expect(status.blockers[0]?.reason).toBe('active_events');
    });

    it('rejects a wrong password, then anonymises like the retention job and closes sole organizations', async () => {
      const soleOrg = await org({ name: 'Nur ich' });
      const sharedOrg = await org({ name: 'Mit Anderen' });
      const userId = await user();
      const otherAdmin = await user();
      await member(userId, soleOrg);
      await member(userId, sharedOrg);
      await member(otherAdmin, sharedOrg);
      await withPassword(userId, 'richtig123');
      await sql(`UPDATE users SET newsletter_opt_in_at = now() WHERE id = $1`, [
        userId,
      ]);
      const email = (
        await one(`SELECT email FROM users WHERE id = $1`, [userId])
      ).email;

      const status = await deletion.status(userId);
      expect(status.confirmation).toBe('password');
      expect(status.closesOrganizations).toEqual([
        { organizationId: soleOrg, name: 'Nur ich' },
      ]);

      await expect(deletion.deleteAccount(userId, {})).rejects.toThrow(
        'Passwort',
      );
      await expect(
        deletion.deleteAccount(userId, { password: 'falsch' }),
      ).rejects.toThrow('stimmt nicht');
      sent.length = 0;

      const result = await deletion.deleteAccount(userId, {
        password: 'richtig123',
      });

      expect(result.trigger).toBe('self_service');
      expect(result.executedByUserId).toBe(userId);
      expect(result.counts.accountsAnonymised).toBe(1);
      expect(result.counts.organizationsClosed).toBe(1);
      const row = await one(
        `SELECT email, first_name, last_name, password_hash, is_active, newsletter_opt_in_at, deleted_at FROM users WHERE id = $1`,
        [userId],
      );
      expect(row.email).toBe(`deleted-${userId}@deleted.invalid`);
      expect(row.first_name).toBe('Gelöschtes');
      expect(row.password_hash).toBeNull();
      expect(row.is_active).toBe(false);
      expect(row.newsletter_opt_in_at).toBeNull();
      expect(row.deleted_at).not.toBeNull();
      expect(
        await sql(`SELECT 1 FROM user_organizations WHERE user_id = $1`, [
          userId,
        ]),
      ).toHaveLength(0);
      expect(
        (
          await one(`SELECT deleted_at FROM organizations WHERE id = $1`, [
            soleOrg,
          ])
        ).deleted_at,
      ).not.toBeNull();
      expect(
        (
          await one(`SELECT deleted_at FROM organizations WHERE id = $1`, [
            sharedOrg,
          ])
        ).deleted_at,
      ).toBeNull();
      const mail = sent.find((m) => m.to === email);
      expect(mail?.subject).toBe('Dein OpenEOS-Konto wurde gelöscht');
      expect(mail?.text).toContain('„Nur ich“');
    });

    it('accounts without password confirm with an e-mail code', async () => {
      const userId = await user();
      await sql(`UPDATE users SET password_hash = NULL WHERE id = $1`, [
        userId,
      ]);
      const email = (
        await one(`SELECT email FROM users WHERE id = $1`, [userId])
      ).email;
      expect((await deletion.status(userId)).confirmation).toBe('email_code');
      sent.length = 0;
      await deletion.sendCode(userId);
      const code = /\b(\d{6})\b/.exec(
        sent.find((m) => m.to === email)?.text ?? '',
      )?.[1];
      expect(code).toBeDefined();
      await expect(
        deletion.deleteAccount(userId, {
          code: '000000' === code ? '111111' : '000000',
        }),
      ).rejects.toThrow('Code');
      const result = await deletion.deleteAccount(userId, { code: code! });
      expect(result.status).toBe('succeeded');
      // Der Code ist verbraucht.
      expect(
        await sql(
          `SELECT 1 FROM email_otps WHERE user_id = $1 AND used_at IS NULL`,
          [userId],
        ),
      ).toHaveLength(0);
    });

    it('refuses while the user has transactions without a cash point closing', async () => {
      const orgId = await org();
      const userId = await user();
      const other = await user();
      await member(userId, orgId);
      await member(other, orgId);
      const { txId } = await fiscal(orgId, null, { closed: false });
      await sql(`UPDATE tse_transactions SET user_id = $2 WHERE id = $1`, [
        txId,
        userId,
      ]);
      const status = await deletion.status(userId);
      expect(status.unclosedTransactions).toBe(true);
      expect(status.allowed).toBe(false);
    });
  });
});
