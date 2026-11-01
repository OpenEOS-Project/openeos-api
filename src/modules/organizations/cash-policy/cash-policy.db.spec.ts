import { randomUUID } from 'crypto';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Order,
  OrderItem,
  Organization,
  User,
  UserOrganization,
} from '../../../database/entities';
import { GatewayService } from '../../gateway/gateway.service';
import { OrdersService } from '../../orders/orders.service';
import { PaymentsBatchService } from '../../payments/payments-batch.service';
import type { BatchPaymentDto } from '../../payments/dto/batch-payment.dto';
import { OrganizationsService } from '../organizations.service';
import { CashPolicyService } from './cash-policy.service';
import { recordInitialCountry } from './cash-policy.writes';

/**
 * Land, Bargeld-Regel und „Ohne Zahlung abschließen“ gegen ein echtes
 * Postgres (Migration, Sperren, Verlauf, Admin-Protokoll).
 *
 * Laeuft nur mit einer Wegwerf-Datenbank, z. B.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:5547/openeos_country_scratch pnpm test
 *
 * Name muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('Cash policy against Postgres', () => {
  let ds: DataSource;
  const orgIds: string[] = [];
  let admin: User;
  let superAdmin: User;
  const gateway = {
    notifyOrderUpdated: jest.fn(),
    notifyOrderItemStatusChanged: jest.fn(),
  };
  let organizations: OrganizationsService;
  let cashPolicy: CashPolicyService;
  let orders: OrdersService;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name)) {
      throw new Error(`Database "${name}" does not end in _test/_scratch`);
    }
    ds = new DataSource({
      type: 'postgres',
      url: TEST_DB,
      entities: [
        path.join(__dirname, '../../../database/entities/*.entity.ts'),
      ],
      migrations: [path.join(__dirname, '../../../database/migrations/*.ts')],
      migrationsRun: true,
      logging: false,
    });
    await ds.initialize();

    const none = undefined as never;
    organizations = new OrganizationsService(
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
    cashPolicy = new CashPolicyService(ds, organizations, {
      get: () => undefined,
    } as unknown as ConfigService);
    orders = new OrdersService(
      ds.getRepository(Order),
      ds.getRepository(OrderItem),
      none,
      ds.getRepository(Organization),
      ds.getRepository(UserOrganization),
      none,
      none,
      none,
      none,
      none,
      gateway as unknown as GatewayService,
      none,
    );

    const mkUser = async (superAdminFlag: boolean) => {
      const [u] = await ds.query<{ id: string }[]>(
        `INSERT INTO users (email, first_name, last_name, is_active, is_superadmin)
         VALUES ($1, 'Ada', 'Admin', true, $2) RETURNING id`,
        [`cash-${randomUUID()}@example.org`, superAdminFlag],
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

  afterAll(async () => {
    if (ds?.isInitialized) {
      if (orgIds.length) {
        await ds.query(
          `DELETE FROM payments WHERE order_id IN
             (SELECT id FROM orders WHERE organization_id = ANY($1::uuid[]))`,
          [orgIds],
        );
        await ds.query(
          `DELETE FROM order_items WHERE order_id IN
             (SELECT id FROM orders WHERE organization_id = ANY($1::uuid[]))`,
          [orgIds],
        );
        await ds.query(
          `DELETE FROM orders WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
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

  beforeEach(() => jest.clearAllMocks());

  async function q<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return await ds.query(sql, params);
  }

  /** Organisation mit Admin-Mitgliedschaft; ohne Spalte = DB-Standard. */
  async function org(
    options: { country?: string | null; legacy?: boolean } = {},
  ): Promise<string> {
    const id = randomUUID();
    orgIds.push(id);
    if (options.legacy === undefined) {
      await q(
        `INSERT INTO organizations (id, name, slug, support_pin, settings, country)
         VALUES ($1, 'Verein', $2, '123456', '{}', $3)`,
        [id, `verein-${id}`, options.country ?? null],
      );
    } else {
      await q(
        `INSERT INTO organizations (id, name, slug, support_pin, settings, country, cash_policy_legacy)
         VALUES ($1, 'Verein', $2, '123456', '{}', $3, $4)`,
        [id, `verein-${id}`, options.country ?? null, options.legacy],
      );
    }
    await q(
      `INSERT INTO user_organizations (user_id, organization_id, role, permissions)
       VALUES ($1, $2, 'admin', '{}')`,
      [admin.id, id],
    );
    return id;
  }

  function reasonOf(error: unknown): string | undefined {
    return (error as { response?: { reason?: string } }).response?.reason;
  }

  async function caught(call: Promise<unknown>): Promise<unknown> {
    try {
      await call;
    } catch (e) {
      return e;
    }
    throw new Error('expected a rejection');
  }

  describe('country and legacy columns', () => {
    it('new rows start without legacy protection (migration default false)', async () => {
      const id = await org({ country: 'DE' });
      const loaded = await ds
        .getRepository(Organization)
        .findOneByOrFail({ id });
      expect(loaded.cashPolicyLegacy).toBe(false);
      expect(loaded.cashPolicy).toBe('blocked_de_no_tse');
      expect(loaded.cashPolicyReason).toBe('de_no_tse');
    });

    it('recordInitialCountry mirrors the country into settings and logs it', async () => {
      const id = await org({ legacy: false });
      await ds.transaction((m) => recordInitialCountry(m, id, 'AT', admin));
      const [row] = await q<{ country: string; c: string }>(
        `SELECT country, settings->'address'->>'country' AS c FROM organizations WHERE id = $1`,
        [id],
      );
      expect(row).toEqual({ country: 'AT', c: 'AT' });
      const history = await cashPolicy.history(id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        kind: 'country',
        fromValue: null,
        toValue: 'AT',
      });
    });
  });

  describe('one-time country for existing organizations', () => {
    it('sets the country once, then refuses (COUNTRY_ALREADY_SET)', async () => {
      const id = await org({ legacy: true });
      const state = await cashPolicy.setCountryOnce(id, 'de', admin);
      expect(state).toEqual({
        country: 'DE',
        cashPolicy: 'allowed',
        cashPolicyLegacy: true,
        cashPolicyReason: 'legacy',
      });
      const error = await caught(cashPolicy.setCountryOnce(id, 'AT', admin));
      expect(reasonOf(error)).toBe('COUNTRY_ALREADY_SET');
      const [row] = await q<{ country: string }>(
        `SELECT country FROM organizations WHERE id = $1`,
        [id],
      );
      expect(row.country).toBe('DE');
    });

    it('rejects unknown codes', async () => {
      const id = await org({ legacy: true });
      const error = await caught(cashPolicy.setCountryOnce(id, 'XX', admin));
      expect(reasonOf(error)).toBe('COUNTRY_INVALID');
    });

    it('the general organization update cannot change the country', async () => {
      const id = await org({ country: 'DE', legacy: true });
      await organizations.update(
        id,
        { settings: { address: { street: 'Weg 1', country: 'AT' } } },
        admin,
      );
      const [row] = await q<{ country: string; c: string }>(
        `SELECT country, settings->'address'->>'country' AS c FROM organizations WHERE id = $1`,
        [id],
      );
      expect(row).toEqual({ country: 'DE', c: 'DE' });
    });
  });

  describe('voluntary switch to "Germany without cash"', () => {
    it('is one-way for a legacy DE organization', async () => {
      const id = await org({ country: 'DE', legacy: true });
      const state = await cashPolicy.adoptCountryPolicy(id, admin);
      expect(state.cashPolicy).toBe('blocked_de_no_tse');
      expect(state.cashPolicyLegacy).toBe(false);
      const again = await caught(cashPolicy.adoptCountryPolicy(id, admin));
      expect(reasonOf(again)).toBe('CASH_POLICY_ALREADY_ACTIVE');
      const [entry] = await cashPolicy.history(id);
      expect(entry).toMatchObject({
        kind: 'policy',
        fromValue: 'legacy',
        toValue: 'country',
        bySupport: false,
      });
    });

    it('is only offered in Germany', async () => {
      const id = await org({ country: 'AT', legacy: true });
      const error = await caught(cashPolicy.adoptCountryPolicy(id, admin));
      expect(reasonOf(error)).toBe('CASH_POLICY_SWITCH_REQUIRES_DE');
    });

    it('hides the cashless toggle afterwards (CASH_NOT_ALLOWED_IN_COUNTRY)', async () => {
      const id = await org({ country: 'DE', legacy: false });
      const error = await caught(
        organizations.setCashlessMode(id, false, admin),
      );
      expect(error).toMatchObject({
        response: {
          code: 'CASH_NOT_ALLOWED_IN_COUNTRY',
          reason: 'CASHLESS_TOGGLE_NOT_AVAILABLE',
        },
      });
    });
  });

  describe('super admin', () => {
    it('changes the country with a reason and writes the admin audit log', async () => {
      const id = await org({ country: 'DE', legacy: false });
      const state = await cashPolicy.adminSetCountry(
        id,
        'AT',
        'Verein sitzt in Österreich',
        superAdmin,
        { ipAddress: '127.0.0.1' },
      );
      expect(state).toMatchObject({ country: 'AT', cashPolicy: 'allowed' });
      const [audit] = await q<{
        action: string;
        reason: string;
        details: { before: { country: string }; after: { country: string } };
      }>(
        `SELECT action, reason, details FROM admin_audit_logs
          WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [id],
      );
      expect(audit.action).toBe('set_organization_country');
      expect(audit.reason).toBe('Verein sitzt in Österreich');
      expect(audit.details.before.country).toBe('DE');
      expect(audit.details.after.country).toBe('AT');
      const unchanged = await caught(
        cashPolicy.adminSetCountry(id, 'AT', 'nochmal AT', superAdmin),
      );
      expect(reasonOf(unchanged)).toBe('COUNTRY_UNCHANGED');
    });

    it('can restore legacy protection after a voluntary switch', async () => {
      const id = await org({ country: 'DE', legacy: true });
      await cashPolicy.adoptCountryPolicy(id, admin);
      const state = await cashPolicy.adminSetLegacy(
        id,
        true,
        'Wechsel war ein Versehen',
        superAdmin,
      );
      expect(state.cashPolicy).toBe('allowed');
      const [audit] = await q<{ action: string }>(
        `SELECT action FROM admin_audit_logs WHERE organization_id = $1`,
        [id],
      );
      expect(audit.action).toBe('set_cash_policy');
    });
  });

  describe('certificate', () => {
    it('is a PDF for "Germany without cash" only', async () => {
      const blocked = await org({ country: 'DE', legacy: false });
      const { pdf, filename } = await cashPolicy.certificatePdf(blocked, admin);
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
      expect(filename).toMatch(/^openeos-bescheinigung-ohne-bargeld-/);

      const legacy = await org({ country: 'DE', legacy: true });
      const error = await caught(cashPolicy.certificatePdf(legacy, admin));
      expect(reasonOf(error)).toBe('CERTIFICATE_REQUIRES_CASH_POLICY');
    });
  });

  describe('„Ohne Zahlung abschließen“', () => {
    async function event(orgId: string) {
      const [e] = await q<{ id: string }>(
        `INSERT INTO events (organization_id, name, status) VALUES ($1, 'Fest', 'active') RETURNING id`,
        [orgId],
      );
      const [station] = await q<{ id: string }>(
        `INSERT INTO production_stations (event_id, name) VALUES ($1, 'Grill') RETURNING id`,
        [e.id],
      );
      const [category] = await q<{ id: string }>(
        `INSERT INTO categories (event_id, name) VALUES ($1, 'Essen') RETURNING id`,
        [e.id],
      );
      const [product] = await q<{ id: string }>(
        `INSERT INTO products (event_id, category_id, name, price, tax_rate)
         VALUES ($1, $2, 'Burger', 9, 19) RETURNING id`,
        [e.id, category.id],
      );
      productId = product.id;
      categoryId = category.id;
      return { eventId: e.id, stationId: station.id };
    }

    let n = 0;
    let productId = '';
    let categoryId = '';
    async function unpaidOrder(
      orgId: string,
      eventId: string,
      stationId: string | null,
      itemStatus = 'pending',
    ) {
      n += 1;
      const [o] = await q<{ id: string }>(
        `INSERT INTO orders (organization_id, event_id, order_number, daily_number,
           subtotal, total, paid_amount, payment_status, status, fulfillment_type)
         VALUES ($1, $2, $3, $4, 12, 12, 0, 'unpaid', 'open', 'counter_pickup')
         RETURNING id`,
        [orgId, eventId, `CP-${n}-${randomUUID().slice(0, 6)}`, n],
      );
      const [drink] = await q<{ id: string }>(
        `INSERT INTO order_items (order_id, product_id, category_id, category_name, product_name, quantity, unit_price, tax_rate, total_price, status, sort_order)
         VALUES ($1, $2, $3, 'Essen', 'Cola', 1, 3, 19, 3, 'pending', 0) RETURNING id`,
        [o.id, productId, categoryId],
      );
      const [food] = await q<{ id: string }>(
        `INSERT INTO order_items (order_id, product_id, category_id, category_name, product_name, quantity, unit_price, tax_rate, total_price, status, production_station_id, sort_order)
         VALUES ($1, $4, $5, 'Essen', 'Burger', 1, 9, 19, 9, $2, $3, 1) RETURNING id`,
        [o.id, itemStatus, stationId, productId, categoryId],
      );
      return { orderId: o.id, drinkId: drink.id, foodId: food.id };
    }

    async function state(orderId: string) {
      const [row] = await q<{
        status: string;
        payment_status: string;
        paid_amount: string;
        closed: Date | null;
        payments: string;
      }>(
        `SELECT o.status, o.payment_status, o.paid_amount,
                o.closed_without_payment_at AS closed,
                (SELECT count(*) FROM payments p WHERE p.order_id = o.id) AS payments
           FROM orders o WHERE o.id = $1`,
        [orderId],
      );
      return row;
    }

    it('completes right away when no station works on it: no payment, nothing paid', async () => {
      const orgId = await org({ country: 'DE', legacy: false });
      const { eventId } = await event(orgId);
      const o = await unpaidOrder(orgId, eventId, null);
      const result = await orders.closeWithoutPaymentForDevice(orgId, [
        o.orderId,
      ]);
      expect(result.orders).toEqual([{ id: o.orderId, status: 'completed' }]);
      const row = await state(o.orderId);
      expect(row.status).toBe('completed');
      expect(row.payment_status).toBe('unpaid');
      expect(Number(row.paid_amount)).toBe(0);
      expect(row.closed).not.toBeNull();
      expect(Number(row.payments)).toBe(0);
      const items = await q<{ status: string }>(
        `SELECT status FROM order_items WHERE order_id = $1`,
        [o.orderId],
      );
      expect(items.every((i) => i.status === 'delivered')).toBe(true);
    });

    it('keeps the kitchen order until the station hands it out, then completes', async () => {
      const orgId = await org({ country: 'DE', legacy: false });
      const { eventId, stationId } = await event(orgId);
      const o = await unpaidOrder(orgId, eventId, stationId, 'pending');
      await orders.closeWithoutPaymentForDevice(orgId, [o.orderId]);
      let row = await state(o.orderId);
      expect(row.status).toBe('open');
      expect(row.closed).not.toBeNull();

      // Nicht mehr offen fuer eine Zahlung
      const [open] = await q<{ n: string }>(
        `SELECT count(*) AS n FROM orders WHERE id = $1
           AND payment_status IN ('unpaid','partly_paid')
           AND status NOT IN ('cancelled','completed')
           AND closed_without_payment_at IS NULL`,
        [o.orderId],
      );
      expect(Number(open.n)).toBe(0);

      await q(`UPDATE order_items SET status = 'ready' WHERE id = $1`, [
        o.foodId,
      ]);
      await orders.deliverItemsForDevice(orgId, [o.foodId]);
      row = await state(o.orderId);
      expect(row.status).toBe('completed');
      expect(Number(row.payments)).toBe(0);
    });

    it('refuses a later payment (ORDER_CLOSED_WITHOUT_PAYMENT)', async () => {
      const orgId = await org({ country: 'DE', legacy: false });
      const { eventId, stationId } = await event(orgId);
      const o = await unpaidOrder(orgId, eventId, stationId, 'pending');
      await orders.closeWithoutPaymentForDevice(orgId, [o.orderId]);
      const batch = new PaymentsBatchService(ds, {} as never, {} as never);
      const error = await caught(
        batch.payBatch(orgId, 'device-1', {
          paymentMethod: 'card',
          orderIds: [o.orderId],
        } as BatchPaymentDto),
      );
      expect(reasonOf(error)).toBe('ORDER_CLOSED_WITHOUT_PAYMENT');
    });

    it('is not offered where cash is allowed (legacy, AT)', async () => {
      for (const options of [
        { country: 'DE', legacy: true },
        { country: 'AT', legacy: false },
      ]) {
        const orgId = await org(options);
        const { eventId } = await event(orgId);
        const o = await unpaidOrder(orgId, eventId, null);
        const error = await caught(
          orders.closeWithoutPaymentForDevice(orgId, [o.orderId]),
        );
        expect(reasonOf(error)).toBe('CLOSE_WITHOUT_PAYMENT_NOT_AVAILABLE');
        const viaComplete = await caught(
          orders.completeOrdersForDevice(orgId, [o.orderId]),
        );
        expect(reasonOf(viaComplete)).toBe('ORDER_NOT_FULLY_PAID');
      }
    });

    it('POST /device-api/orders/complete closes without payment for DE', async () => {
      const orgId = await org({ country: 'DE', legacy: false });
      const { eventId } = await event(orgId);
      const o = await unpaidOrder(orgId, eventId, null);
      const result = await orders.completeOrdersForDevice(orgId, [o.orderId]);
      expect(result.orders[0].status).toBe('completed');
      expect(Number((await state(o.orderId)).payments)).toBe(0);
    });
  });
});
