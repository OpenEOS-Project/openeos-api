import { INVALID_WHERE_VALUES_BEHAVIOR } from '../../config/where-values';
import { randomUUID } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  CashbookEntry,
  CashPointClosing,
  Organization,
  User,
} from '../../database/entities';
import type { CronLockService } from '../../common/redis/cron-lock.service';
import type { TseConfig } from '../tse/tse.config';
import type { TseSigningService } from '../tse/tse-signing.service';
import type { TseUnitService } from '../tse/tse-unit.service';
import {
  cashbookProcessData,
  clientIdForOrganization,
} from '../tse/tse-process-data';
import { KeepLateTseSignaturesAsOutage1842000000000 } from '../../database/migrations/1842000000000-KeepLateTseSignaturesAsOutage';
import { Order } from '../../database/entities/order.entity';
import { ReportsService } from '../reports/reports.service';
import { rowsOf } from '../tse/tse-sql.util';
import { CashbookService } from './cashbook.service';
import { CashPointClosingService } from './cash-point-closing.service';
import { validateZip } from './dsfinvk-validator';
import { readZip } from './dsfinvk-zip';
import { parseCsv } from './dsfinvk-format';
import {
  Sequence,
  VAT_EXEMPT,
  VAT_LIABLE,
  failed,
  pfandReturn,
  refund,
  sale,
  tableOrder,
} from './testing/dsfinvk-fixtures';

/**
 * Kassenabschluss, Trigger (BON_ID, Unveraenderlichkeit) und Kassenbuch
 * gegen ein echtes Postgres. Nur mit Wegwerf-Datenbank, z. B.
 *
 *   TEST_DSFINVK_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:55440/openeos_dsfinvk_scratch pnpm test dsfinvk.db
 *
 * Name muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_DSFINVK_DATABASE_URL;

type Row = Record<string, string | null>;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('DSFinV-K closings against Postgres', () => {
  let ds: DataSource;
  let exportDir: string;
  let closings: CashPointClosingService;
  let cashbook: CashbookService;
  const audit = jest.fn();
  const orgIds: string[] = [];
  const admin = { id: randomUUID(), isSuperAdmin: true } as User;
  const sql = async (text: string, params: unknown[] = []): Promise<Row[]> =>
    rowsOf<Row>(await ds.query(text, params));

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name))
      throw new Error(`Database "${name}" does not end in _test/_scratch`);
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
    exportDir = mkdtempSync(path.join(tmpdir(), 'dsfinvk-'));
    const units = {
      assertAdmin: async (id: string) =>
        ds.getRepository(Organization).findOneByOrFail({ id }),
      audit,
    } as unknown as TseUnitService;
    closings = new CashPointClosingService(
      ds,
      ds.getRepository(CashPointClosing),
      ds.getRepository(Organization),
      units,
      { settings: { exportDir } } as unknown as TseConfig,
      {
        runExclusive: async (_n: string, job: () => Promise<void>) => {
          await job();
          return true;
        },
      } as unknown as CronLockService,
    );
    // Signatur wie TseSigningService.signCashbook, ohne Swissbit.
    const signing = {
      signCashbook: async (input: {
        organizationId: string;
        entryId: string;
        cashbookType: string;
        amountCents: number;
        terminal?: string | null;
      }) => {
        const [row] = await sql(
          `INSERT INTO tse_transactions (organization_id, tse_unit_id, kind, process_type, process_data, status, client_id,
             serial_number, transaction_number, signature_counter, start_time, finish_time, signature_value, amount, lines, terminal)
           SELECT $1, u.id, 'cashbook', 'Kassenbeleg-V1', $2, 'signed', u.client_id, u.serial_number,
             900 + (SELECT count(*) FROM tse_transactions t WHERE t.organization_id = $1),
             2000 + (SELECT count(*) FROM tse_transactions t WHERE t.organization_id = $1), now(), now(), 'c2ln', $3, $4, $5
             FROM tse_units u WHERE u.organization_id = $1 RETURNING id`,
          [
            input.organizationId,
            cashbookProcessData(input.amountCents),
            (input.amountCents / 100).toFixed(2),
            JSON.stringify({
              cashbookType: input.cashbookType,
              amountCents: input.amountCents,
              entryId: input.entryId,
            }),
            input.terminal ?? null,
          ],
        );
        return { id: row.id } as never;
      },
    } as unknown as TseSigningService;
    cashbook = new CashbookService(
      ds,
      ds.getRepository(CashbookEntry),
      ds.getRepository(Organization),
      signing,
    );
  }, 120_000);

  afterAll(async () => {
    if (ds?.isInitialized) {
      if (orgIds.length) {
        // Abschluesse sind absichtlich nicht loeschbar — fuer den Testabbau
        // den Schutz kurz aussetzen.
        await sql(
          `ALTER TABLE cash_point_closings DISABLE TRIGGER cash_point_closings_immutable`,
        );
        for (const table of [
          'cashbook_entries',
          'cash_point_closings',
          'tse_transactions',
          'tse_units',
          'cash_registers',
          'pfand_returns',
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
          `DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE organization_id = ANY($1::uuid[]))`,
          [orgIds],
        );
        await sql(
          `DELETE FROM orders WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
        await sql(
          `DELETE FROM devices WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
        await sql(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
          orgIds,
        ]);
      }
      await ds.destroy();
    }
    rmSync(exportDir, { recursive: true, force: true });
  });

  async function world(settings: Record<string, unknown> = {}) {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await sql(
      `INSERT INTO organizations (id, name, slug, support_pin, settings, country, operating_mode, tse_active)
       VALUES ($1, 'TSV Musterdorf e. V.', $2, '123456', $3, 'DE', 'full', true)`,
      [
        orgId,
        `tsv-${orgId}`,
        JSON.stringify({
          currency: 'EUR',
          vatExempt: false,
          taxNumber: '12/345/67890',
          contact: {
            address: 'Sportplatzweg 1',
            zipCode: '12345',
            city: 'Musterdorf',
          },
          integrations: { tse: { enabled: true } },
          ...settings,
        }),
      ],
    );
    const [unit] = await sql(
      `INSERT INTO tse_units (organization_id, state, serial_number, product_type, client_id, trigger, public_key,
         signature_algorithm, log_time_format, certificate, activated_at)
       VALUES ($1, 'active', $2, '850007', $3, 'manual', 'BHhWOeisRpPBTGQ1W4VUH95TXx2GARf8e2NYZXJoInjtGqnxJ8sZ3CQpYgjI+LYEmW5A37sLWHsyU7nSJUBemyU=',
               'ecdsa-plain-SHA256', 'unixTime', 'MIIB', now()) RETURNING id`,
      [
        orgId,
        randomUUID().replace(/-/g, '').repeat(2),
        clientIdForOrganization(orgId),
      ],
    );
    const [device] = await sql(
      `INSERT INTO devices (organization_id, name, type, device_token, settings, status)
       VALUES ($1, 'Kasse Theke', 'pos', $2, '{}', 'verified') RETURNING id`,
      [orgId, `tok-${randomUUID()}`],
    );
    return { orgId, unitId: unit.id!, deviceId: device.id! };
  }

  /** Fixture-Vorgang in die Datenbank (ohne bon_id → Trigger vergibt sie). */
  async function insert(
    w: { orgId: string; unitId: string; deviceId: string },
    tx: ReturnType<typeof sale>,
    at: Date,
    extra: { referencesId?: string } = {},
  ) {
    const [row] = await sql(
      `INSERT INTO tse_transactions (organization_id, tse_unit_id, kind, process_type, process_data, training, status, client_id,
         serial_number, transaction_number, signature_counter, start_time, finish_time, signature_value, amount, lines,
         error_code, error_message, terminal, order_id, references_tse_transaction_id, created_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, u.client_id, u.serial_number, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
         FROM tse_units u WHERE u.id = $2 RETURNING id, bon_id`,
      [
        w.orgId,
        w.unitId,
        tx.kind,
        tx.processType,
        tx.processData,
        tx.training,
        tx.status,
        tx.transactionNumber,
        tx.signatureCounter,
        tx.status === 'failed' ? null : at,
        tx.status === 'failed' ? null : at,
        tx.signatureValue,
        tx.amountCents !== null ? (tx.amountCents / 100).toFixed(2) : null,
        JSON.stringify(tx.lines),
        tx.errorCode,
        tx.errorMessage,
        w.deviceId,
        tx.orderId && /^[0-9a-f-]{36}$/.test(tx.orderId) ? tx.orderId : null,
        extra.referencesId ?? null,
        at,
      ],
    );
    return row;
  }

  it('late signature (Frage 16): legacy recovered rows go back to failed, the closing marks them „Signatur nach Belegausgabe“', async () => {
    const w = await world();
    const seq = new Sequence();
    const at = new Date('2026-10-20T17:00:00Z');
    const s1 = sale(seq, VAT_LIABLE, {
      items: [{ name: 'Bier', quantity: 1, price: 4, rate: 19 }],
    });
    const row = await insert(w, s1, at);
    // Bestand: frueher als „signed“ uebernommen (recovered_at gesetzt).
    await sql(
      `UPDATE tse_transactions SET recovered_at = $2, error_code = 'E_TIMEOUT' WHERE id = $1`,
      [row.id, new Date('2026-10-20T17:05:00Z')],
    );
    const runner = ds.createQueryRunner();
    try {
      await new KeepLateTseSignaturesAsOutage1842000000000().up(runner);
    } finally {
      await runner.release();
    }
    const [after] = await sql(
      `SELECT status, signature_value FROM tse_transactions WHERE id = $1`,
      [row.id],
    );
    expect(after).toMatchObject({
      status: 'failed',
      signature_value: s1.signatureValue,
    });

    await closings.closeUpTo(w.orgId, new Date('2026-10-21T05:00:00Z'), {
      trigger: 'scheduled',
    });
    const file = await closings.exportZip(
      w.orgId,
      admin,
      { from: '2026-10-20', to: '2026-10-20' },
      {},
    );
    const result = validateZip(file.data);
    expect(result.errors.map((e) => `${e.code} ${e.message}`)).toEqual([]);
    expect(result.stats.tseFailures).toBe(1);
    const [, first] = parseCsv(
      readZip(file.data)
        .find((e) => e.name === 'transactions_tse.csv')!
        .data.toString('utf8'),
    ).records;
    const values = first.values.join('|');
    expect(values).toContain(
      'Signatur nach Belegausgabe (TSE nicht erreichbar: E_TIMEOUT',
    );
    expect(values).toContain(s1.signatureValue!);
  });

  it('assigns gapless BON_IDs, closes per business day, exports a valid ZIP and keeps closings immutable', async () => {
    const w = await world();
    const seq = new Sequence();
    const day1 = new Date('2026-10-30T18:00:00Z');
    const day1late = new Date('2026-10-31T03:30:00Z'); // 04:30 Berlin → noch Geschaeftstag 30.10.
    const day2 = new Date('2026-10-31T16:00:00Z');
    const s1 = sale(seq, VAT_LIABLE, {
      items: [
        { name: 'Bier', quantity: 2, price: 4, rate: 19 },
        { name: 'Wurst', quantity: 1, price: 3.5, rate: 7 },
      ],
    });
    const r1 = await insert(w, s1, day1);
    const r2 = await insert(
      w,
      failed(
        sale(seq, VAT_LIABLE, {
          items: [{ name: 'Cola', quantity: 1, price: 3, rate: 19 }],
        }),
      ),
      day1late,
    );
    const orderId = randomUUID();
    const o = tableOrder(seq, {
      items: [{ name: 'Schnitzel', quantity: 1, price: 12, rate: 7 }],
      orderNumber: '5',
      orderId,
      tableNumber: '4',
    });
    await insert(w, o, day2);
    const st = refund(seq, VAT_LIABLE, {
      original: s1,
      closing: { zNr: 1, createdAt: new Date() },
      items: [
        { name: 'Bier', quantity: 2, unitPrice: 4, taxRate: 19, amount: 8 },
        { name: 'Wurst', quantity: 1, unitPrice: 3.5, taxRate: 7, amount: 3.5 },
      ],
    });
    await insert(w, st, day2, { referencesId: r1.id! });
    await insert(
      w,
      pfandReturn(seq, [{ name: 'Becher', unitAmount: 2, quantity: 2 }]),
      day2,
    );

    const bonIds = await sql(
      `SELECT bon_id FROM tse_transactions WHERE organization_id = $1 ORDER BY bon_id`,
      [w.orgId],
    );
    expect(bonIds.map((b) => Number(b.bon_id))).toEqual([1, 2, 3, 4, 5]);
    expect(Number(r2.bon_id)).toBe(2);

    // Ein Abschluss je Geschaeftstag, aeltester zuerst.
    const created = await closings.closeUpTo(
      w.orgId,
      new Date('2026-11-01T05:00:00Z'),
      { trigger: 'scheduled' },
    );
    expect(
      created.map((c) => [c.zNr, c.businessDate, c.transactionCount]),
    ).toEqual([
      [1, '2026-10-30', 2],
      [2, '2026-10-31', 3],
    ]);
    // Nichts mehr offen → kein weiterer Abschluss.
    expect(
      await closings.closeUpTo(w.orgId, new Date(), { trigger: 'manual' }),
    ).toEqual([]);

    const file = await closings.exportZip(
      w.orgId,
      admin,
      { from: '2026-10-30', to: '2026-10-31' },
      {},
    );
    const result = validateZip(file.data);
    expect(result.errors.map((e) => `${e.code} ${e.message}`)).toEqual([]);
    expect(result.stats).toMatchObject({
      closings: 2,
      transactions: 5,
      tseFailures: 1,
    });
    // Storno verweist auf den Beleg im ersten Abschluss.
    const refs = readZip(file.data)
      .find((e) => e.name === 'references.csv')!
      .data.toString('utf8');
    const [, ...refRows] = parseCsv(refs).records;
    expect(
      refRows.map((r) => [r.values[2], r.values[3], r.values[9], r.values[10]]),
    ).toEqual([['2', '4', '1', '1']]);
    expect(audit).toHaveBeenCalledWith(
      'dsfinvk_exported',
      w.orgId,
      null,
      expect.anything(),
    );

    // Abgelegtes ZIP je Abschluss mit Pruefsumme, reproduzierbar.
    await closings.storePendingExports();
    const stored = await ds
      .getRepository(CashPointClosing)
      .findOneByOrFail({ organizationId: w.orgId, zNr: 1 });
    expect(stored.exportFilePath).toMatch(
      new RegExp(`^${w.orgId}/dsfinvk/Z000001_2026-10-30\\.zip$`),
    );
    const onDisk = readFileSync(path.join(exportDir, stored.exportFilePath!));
    const again = await closings.closingFile(w.orgId, stored.id, admin);
    expect(again.data.equals(onDisk)).toBe(true);
    expect(validateZip(onDisk).ok).toBe(true);

    // Unveraenderlich.
    await expect(
      sql(`UPDATE cash_point_closings SET z_nr = 9 WHERE id = $1`, [stored.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql(`UPDATE cash_point_closings SET rows = '{}'::jsonb WHERE id = $1`, [
        stored.id,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql(`DELETE FROM cash_point_closings WHERE id = $1`, [stored.id]),
    ).rejects.toThrow(/cannot be deleted/);
    await sql(
      `UPDATE cash_point_closings SET archived_at = now() WHERE id = $1`,
      [stored.id],
    );
  });

  it('Pfand with VAT (2026-11): sale, refund and Pfand return close and export at the rate of the Pfand type', async () => {
    const w = await world();
    const seq = new Sequence();
    const at = new Date('2026-11-09T18:00:00Z');
    const s1 = sale(seq, VAT_LIABLE, {
      items: [
        {
          name: 'Pils',
          quantity: 2,
          price: 4,
          rate: 19,
          deposit: 2,
          depositRate: 19,
        },
      ],
    });
    const r1 = await insert(w, s1, at);
    await insert(
      w,
      refund(seq, VAT_LIABLE, {
        original: s1,
        closing: { zNr: 1, createdAt: at },
        items: [
          {
            name: 'Pils',
            quantity: 1,
            unitPrice: 4,
            taxRate: 19,
            amount: 4,
            deposit: 2,
            depositRate: 19,
          },
        ],
        kind: 'refund',
      }),
      at,
      { referencesId: r1.id! },
    );
    // Rueckgabe eines Bechers von vor der Umstellung (ohne Satz) und eines neuen.
    await insert(
      w,
      pfandReturn(seq, [
        { name: 'Becher', unitAmount: 2, quantity: 1, vatRate: 19 },
      ]),
      at,
    );
    await insert(
      w,
      pfandReturn(seq, [{ name: 'Becher', unitAmount: 2, quantity: 1 }]),
      at,
    );
    await closings.closeUpTo(w.orgId, new Date('2026-11-10T05:00:00Z'), {
      trigger: 'scheduled',
    });
    const file = await closings.exportZip(
      w.orgId,
      admin,
      { from: '2026-11-09', to: '2026-11-09' },
      {},
    );
    const result = validateZip(file.data);
    expect(result.errors.map((e) => `${e.code} ${e.message}`)).toEqual([]);
    const csv = (name: string) => {
      const [header, ...records] = parseCsv(
        readZip(file.data)
          .find((e) => e.name === name)!
          .data.toString('utf8'),
      ).records;
      return records.map((r) =>
        Object.fromEntries(header.values.map((h, i) => [h, r.values[i]])),
      );
    };
    const cases = csv('businesscases.csv')
      .filter((r) => r.GV_TYP.startsWith('Pfand'))
      .map((r) => [r.GV_TYP, r.UST_SCHLUESSEL, r.Z_UMS_BRUTTO])
      .sort();
    expect(cases).toEqual([
      ['Pfand', '1', '2,00'],
      ['PfandRueckzahlung', '1', '-2,00'],
      ['PfandRueckzahlung', '5', '-2,00'],
    ]);
  });

  it('BEDIENER: server name from the snapshot at signing, member name live for old rows, empty without person', async () => {
    const w = await world();
    const seq = new Sequence();
    const at = new Date('2026-11-10T18:00:00Z');
    const items = [{ name: 'Bier', quantity: 1, price: 4, rate: 19 }];
    const byWaiter = await insert(w, sale(seq, VAT_LIABLE, { items }), at);
    const byMember = await insert(w, sale(seq, VAT_LIABLE, { items }), at);
    const byNobody = await insert(w, sale(seq, VAT_LIABLE, { items }), at);
    const waiterId = randomUUID();
    const [member] = await sql(
      `INSERT INTO users (email, first_name, last_name, password_hash)
       VALUES ($1, 'Markus', 'Maier', 'x') RETURNING id`,
      [`m-${randomUUID()}@example.com`],
    );
    // Snapshot beim Signieren; die Bedienung darf danach anonymisiert sein.
    await sql(
      `UPDATE tse_transactions SET waiter_id = $2, operator_name = 'Anna Berger' WHERE id = $1`,
      [byWaiter.id, waiterId],
    );
    await sql(`UPDATE tse_transactions SET user_id = $2 WHERE id = $1`, [
      byMember.id,
      member.id,
    ]);
    await closings.closeUpTo(w.orgId, new Date('2026-11-11T05:00:00Z'), {
      trigger: 'scheduled',
    });
    const file = await closings.exportZip(
      w.orgId,
      admin,
      { from: '2026-11-10', to: '2026-11-10' },
      {},
    );
    expect(validateZip(file.data).errors).toEqual([]);
    const [header, ...records] = parseCsv(
      readZip(file.data)
        .find((e) => e.name === 'transactions.csv')!
        .data.toString('utf8'),
    ).records;
    const rows = records.map((r) =>
      Object.fromEntries(header.values.map((h, i) => [h, r.values[i]])),
    );
    const bon = (id: string | null) =>
      rows.find(
        (r) =>
          r.BON_ID ===
          String(
            Number(
              ([byWaiter, byMember, byNobody].find((x) => x.id === id) ?? {})
                .bon_id,
            ),
          ),
      );
    expect(bon(byWaiter.id)).toMatchObject({
      BEDIENER_ID: waiterId,
      BEDIENER_NAME: 'Anna Berger',
    });
    expect(bon(byMember.id)).toMatchObject({
      BEDIENER_ID: member.id,
      BEDIENER_NAME: 'Markus Maier',
    });
    expect(bon(byNobody.id)).toMatchObject({
      BEDIENER_ID: '',
      BEDIENER_NAME: '',
    });
    await sql(`DELETE FROM users WHERE id = $1`, [member.id]);
  });

  it('waits for pending TSE transactions before closing', async () => {
    const w = await world();
    const seq = new Sequence();
    const tx = sale(seq, VAT_LIABLE, {
      items: [{ name: 'Bier', quantity: 1, price: 4, rate: 19 }],
    });
    await insert(
      w,
      { ...tx, status: 'pending' as never },
      new Date(Date.now() - 60_000),
    );
    await expect(
      closings.requestClosing(w.orgId, admin, {}),
    ).rejects.toMatchObject({
      response: { code: 'DSFINVK_PENDING_TRANSACTIONS' },
    });
  });

  it('Kassenbuch: Soll-Bestand, signed movements and a valid closing', async () => {
    const w = await world({ vatExempt: true });
    const [order] = await sql(
      `INSERT INTO orders (organization_id, order_number, daily_number, subtotal, total, paid_amount, payment_status, status)
       VALUES ($1, '1', 1, 12, 12, 12, 'paid', 'completed') RETURNING id`,
      [w.orgId],
    );
    await sql(
      `INSERT INTO payments (order_id, amount, payment_method, payment_provider, status, processed_by_device_id)
       VALUES ($1, 12, 'cash', 'CASH', 'captured', $2)`,
      [order.id, w.deviceId],
    );
    await sql(
      `INSERT INTO pfand_returns (organization_id, device_id, total_amount, lines) VALUES ($1, $2, 2, '[]')`,
      [w.orgId, w.deviceId],
    );
    const actor = { deviceId: w.deviceId };
    await cashbook.create(
      w.orgId,
      { type: 'opening_balance', amount: 100, note: 'Wechselgeld' },
      actor,
    );
    await cashbook.create(w.orgId, { type: 'deposit', amount: 50 }, actor);
    await cashbook.create(w.orgId, { type: 'withdrawal', amount: 80 }, actor);
    // Soll: 100 + 50 − 80 + 12 − 2 = 80; gezaehlt 79,50 → Differenz −0,50.
    const count = await cashbook.create(
      w.orgId,
      { type: 'cash_count', amount: 79.5 },
      actor,
    );
    expect(count.entry).toMatchObject({
      type: 'cash_count',
      amount: -0.5,
      expectedAmount: 80,
      countedAmount: 79.5,
      businessCase: 'DifferenzSollIst',
    });
    expect(count.summary).toMatchObject({
      expected: 79.5,
      differences: -0.5,
      cashSales: 12,
      pfandPayouts: -2,
    });
    const day = await cashbook.day(w.orgId, undefined, null);
    expect(day.entries).toHaveLength(4);
    expect(day.devices).toHaveLength(1);
    expect(day.entries.every((e) => e.tseTransactionId)).toBe(true);

    // Nicht gezaehlte Differenz 0 → kein Beleg.
    const zero = await cashbook.create(
      w.orgId,
      { type: 'cash_count', amount: 79.5 },
      actor,
    );
    expect(zero.entry.amount).toBe(0);
    expect(zero.tse).toBeNull();

    const created = await closings.closeUpTo(
      w.orgId,
      new Date(Date.now() + 1000),
      { trigger: 'manual', userId: admin.id },
    );
    expect(created.length).toBeGreaterThanOrEqual(1);
    const file = await closings.exportZip(
      w.orgId,
      admin,
      { zFrom: 1, zTo: created[created.length - 1].zNr },
      {},
    );
    const result = validateZip(file.data);
    expect(result.errors.map((e) => `${e.code} ${e.message}`)).toEqual([]);
    expect(result.stats.transactions).toBe(4);
  });

  it('Kassenbuch (Frage 6): the next day suggests the last counted amount as Anfangsbestand', async () => {
    const w = await world();
    const actor = { deviceId: w.deviceId };
    await cashbook.create(w.orgId, { type: 'deposit', amount: 150 }, actor);
    await cashbook.create(w.orgId, { type: 'cash_count', amount: 140 }, actor);
    const today = (await cashbook.day(w.orgId, undefined, w.deviceId))
      .businessDate;
    expect(
      (await cashbook.day(w.orgId, today, w.deviceId)).openingBalanceSuggestion,
    ).toBeNull();
    const next = new Date(`${today}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const tomorrow = next.toISOString().slice(0, 10);
    expect(
      (await cashbook.day(w.orgId, tomorrow, w.deviceId))
        .openingBalanceSuggestion,
    ).toEqual({ amount: 140, fromBusinessDate: today });
    expect(
      (await cashbook.day(w.orgId, tomorrow, null)).openingBalanceSuggestion,
    ).toEqual({ amount: 140, fromBusinessDate: today });
  });

  it('Kassenbuch: card tip payouts to employees reduce the drawer Soll', async () => {
    const w = await world();
    const actor = { deviceId: w.deviceId };
    await cashbook.create(w.orgId, { type: 'deposit', amount: 100 }, actor);
    await sql(
      `INSERT INTO tip_payouts (organization_id, waiter_id, waiter_name, amount, device_id)
       VALUES ($1, $2, 'Max Minijob', 5.2, $3)`,
      [w.orgId, randomUUID(), w.deviceId],
    );
    const day = await cashbook.day(w.orgId, undefined, w.deviceId);
    expect(day.total).toMatchObject({ tipPayouts: -5.2, expected: 94.8 });
    await sql(`DELETE FROM tip_payouts WHERE organization_id = $1`, [
      w.orgId,
    ]).catch(() => undefined);
  });

  it('Kleinunternehmer → umsatzsteuerpflichtig (Frage 9): closing first, then the master data change', async () => {
    const w = await world({ vatExempt: true });
    const seq = new Sequence();
    await insert(
      w,
      sale(seq, VAT_EXEMPT, {
        items: [{ name: 'Bier', quantity: 1, price: 4, rate: 19 }],
      }),
      new Date(Date.now() - 60_000),
    );
    const result = await closings.changeVatStatus(w.orgId, admin, false, {});
    expect(result.changed).toBe(true);
    expect(result.closings).toHaveLength(1);
    const [org] = await sql(
      `SELECT settings->>'vatExempt' AS exempt, jsonb_array_length(settings->'vatStatusHistory') AS history
         FROM organizations WHERE id = $1`,
      [w.orgId],
    );
    expect(org).toMatchObject({ exempt: 'false', history: 1 });
    expect(audit).toHaveBeenCalledWith(
      'vat_status_changed',
      w.orgId,
      null,
      expect.objectContaining({
        details: expect.objectContaining({
          from: 'vat_exempt',
          to: 'vat_liable',
          closings: [result.closings[0].zNr],
        }) as unknown,
      }),
    );
    // Der Abschluss davor traegt noch den alten Status (Schluessel 6).
    const zNr = result.closings[0].zNr;
    const file = await closings.exportZip(
      w.orgId,
      admin,
      { zFrom: zNr, zTo: zNr },
      {},
    );
    const lineVat = readZip(file.data)
      .find((e) => e.name === 'lines_vat.csv')!
      .data.toString('utf8');
    expect(lineVat).toContain(';6;');
    // Nochmal derselbe Status: nichts passiert.
    expect(
      (await closings.changeVatStatus(w.orgId, admin, false, {})).changed,
    ).toBe(false);
  });

  it('Kleinunternehmer-Grenzen: revenue per calendar year without test bookings', async () => {
    const w = await world({ vatExempt: true });
    const [order] = await sql(
      `INSERT INTO orders (organization_id, order_number, daily_number, status, payment_status, subtotal, total, paid_amount)
       VALUES ($1, 'G-1', 1, 'completed', 'paid', 85000, 85000, 85000) RETURNING id`,
      [w.orgId],
    );
    await sql(
      `INSERT INTO payments (order_id, amount, payment_method, payment_provider, status, created_at)
       VALUES ($1, 85000, 'card', 'SUMUP', 'captured', now())`,
      [order.id],
    );
    await sql(
      `INSERT INTO pfand_returns (organization_id, total_amount, lines) VALUES ($1, 1000, '[]')`,
      [w.orgId],
    );
    const reports = Object.create(ReportsService.prototype) as ReportsService;
    Object.assign(reports, {
      organizationRepository: ds.getRepository(Organization),
      orderRepository: ds.getRepository(Order),
      checkPermission: () => Promise.resolve(),
    });
    const status = await reports.getSmallBusinessStatus(w.orgId, admin);
    expect(status).toMatchObject({
      vatExempt: true,
      currentYearRevenue: 84000,
      limitCurrentYear: 100000,
      warning: 'approaching',
    });
  });

  it('Kassenbuch: per-device rows and a separate row for bookings without device', async () => {
    const w = await world();
    await cashbook.create(
      w.orgId,
      { type: 'opening_balance', amount: 100 },
      { deviceId: w.deviceId },
    );
    await cashbook.create(
      w.orgId,
      { type: 'deposit', amount: 30 },
      { userId: admin.id },
    );
    const day = await cashbook.day(w.orgId, undefined, null);
    expect(day.total.expected).toBe(130);
    const byDevice = new Map(
      day.devices.map((d) => [d.deviceId, d.summary.expected]),
    );
    expect(byDevice.get(w.deviceId)).toBe(100);
    expect(byDevice.get(null)).toBe(30);
  });

  it('refuses the cash book where cash is not allowed', async () => {
    const w = await world();
    await sql(
      `UPDATE organizations SET operating_mode = 'cashless' WHERE id = $1`,
      [w.orgId],
    );
    await expect(
      cashbook.create(
        w.orgId,
        { type: 'deposit', amount: 10 },
        { deviceId: w.deviceId },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
