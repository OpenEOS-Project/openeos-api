import { randomUUID } from 'crypto';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  Category,
  Event,
  OnlineOrderSession,
  Order,
  OrderItem,
  Organization,
  Payment,
  Product,
  ProductionStation,
  QrCode,
  ShopCheckout,
  StockMovement,
  User,
  UserOrganization,
} from '../../database/entities';
import { EventsShopCheckoutController } from '../events/events-shop-checkout.controller';
import { OnlineOrdersService } from '../online-orders/online-orders.service';
import { rowsOf } from '../tse/tse-sql.util';
import { OrdersService } from './orders.service';

/**
 * Optionspreise gegen ein echtes Postgres: Verwaltung, QR-Bestellung und
 * Shop nehmen den Aufpreis aus der Produktdefinition, unbekannte Optionen
 * werden abgelehnt, und ein Produkt einer anderen Organisation laesst sich
 * nicht bestellen. Nur mit Wegwerf-Datenbank (Name endet auf _test/_scratch):
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:5432/openeos_options_scratch pnpm test option-pricing.db
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

type Row = Record<string, string | null>;

const OPTIONS = {
  groups: [
    {
      name: 'Größe',
      type: 'single',
      required: true,
      options: [
        { name: '0,3 l', priceModifier: 0, default: true },
        { name: '0,5 l', priceModifier: 1.5 },
      ],
    },
    {
      name: 'Zutaten',
      type: 'ingredients',
      required: false,
      options: [{ name: 'Zitrone', priceModifier: 0.5 }],
    },
  ],
};

describeWithDb('Option prices against Postgres', () => {
  let ds: DataSource;
  const orgIds: string[] = [];
  const userId = randomUUID();
  const user = { id: userId } as User;
  const print = {
    handleOrderCreated: jest.fn(() => Promise.resolve()),
    handlePaymentReceived: jest.fn(() => Promise.resolve()),
  };
  const gateway = {
    notifyOrderCreated: jest.fn(),
    notifyOrderUpdated: jest.fn(),
    notifyProductUpdated: jest.fn(),
  };
  const config = { get: (_key: string, fallback?: unknown) => fallback };
  const sql = async (text: string, params: unknown[] = []): Promise<Row[]> =>
    rowsOf<Row>(await ds.query(text, params));

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
    await sql(
      `INSERT INTO users (id, email, password_hash, first_name, last_name)
       VALUES ($1, $2, 'x', 'Olli', 'Option')`,
      [userId, `options-${userId}@example.org`],
    );
  }, 120_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    if (ds?.isInitialized) {
      if (orgIds.length) {
        await sql(
          `DELETE FROM shop_checkouts WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
        await sql(
          `DELETE FROM orders WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
        await sql(
          `DELETE FROM online_order_sessions WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
        await sql(
          `DELETE FROM qr_codes WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
        await sql(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
          orgIds,
        ]);
      }
      await sql(`DELETE FROM users WHERE id = $1`, [userId]);
      await ds.destroy();
    }
  });

  /** Verein (bargeldlos) mit Shop, Veranstaltung und Bier mit Optionen. */
  async function world() {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await sql(
      `INSERT INTO organizations (id, name, slug, support_pin, settings, country, operating_mode)
       VALUES ($1, 'SV Optionen e. V.', $2, '123456', $3, 'DE', 'cashless')`,
      [
        orgId,
        `sv-${orgId}`,
        JSON.stringify({
          currency: 'EUR',
          sumup: { apiKey: 'sup_sk_test', merchantCode: 'MCODE' },
          integrations: { sumup: { enabled: true } },
          legal: {
            imprintUrl: 'https://sv.example/impressum',
            privacyUrl: 'https://sv.example/datenschutz',
          },
        }),
      ],
    );
    await sql(
      `INSERT INTO user_organizations (user_id, organization_id, role)
       VALUES ($1, $2, 'admin')`,
      [userId, orgId],
    );
    const [event] = await sql(
      `INSERT INTO events (organization_id, name, status, settings)
       VALUES ($1, 'Sommerfest', 'test', '{"shop": {"enabled": true}}') RETURNING id`,
      [orgId],
    );
    const [category] = await sql(
      `INSERT INTO categories (event_id, name) VALUES ($1, 'Getränke') RETURNING id`,
      [event.id],
    );
    const [bier] = await sql(
      `INSERT INTO products (event_id, category_id, name, price, tax_rate, options)
       VALUES ($1, $2, 'Bier', 4, 19, $3) RETURNING id`,
      [event.id, category.id, JSON.stringify(OPTIONS)],
    );
    return { orgId, eventId: event.id!, bierId: bier.id! };
  }

  function ordersService(): OrdersService {
    return new OrdersService(
      ds.getRepository(Order),
      ds.getRepository(OrderItem),
      ds.getRepository(Product),
      ds.getRepository(Organization),
      ds.getRepository(UserOrganization),
      ds.getRepository(StockMovement),
      ds.getRepository(Event),
      ds.getRepository(ProductionStation),
      print as never,
      {} as never,
      gateway as never,
      config as never,
    );
  }

  function qrService(): OnlineOrdersService {
    return new OnlineOrdersService(
      ds.getRepository(OnlineOrderSession),
      ds.getRepository(QrCode),
      ds.getRepository(Product),
      ds.getRepository(Category),
      ds.getRepository(Order),
      ds.getRepository(OrderItem),
      ds.getRepository(Organization),
      ds.getRepository(Payment),
      {} as never,
      {} as never,
      config as never,
      print as never,
      gateway as never,
    );
  }

  const itemsOf = (orgId: string) =>
    sql(
      `SELECT oi.options_price, oi.total_price, oi.options
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.organization_id = $1`,
      [orgId],
    );

  it('admin orders take option prices from the product definition', async () => {
    const w = await world();
    const order = await ordersService().create(
      w.orgId,
      {
        eventId: w.eventId,
        items: [
          {
            productId: w.bierId,
            quantity: 2,
            selectedOptions: [
              { group: 'Größe', option: '0,5 l', priceModifier: -4 },
              {
                group: 'Zutaten',
                option: 'Zitrone',
                priceModifier: -3,
                excluded: true,
              },
            ],
          },
        ],
      },
      user,
    );

    expect(Number(order.total)).toBe(11);
    const [item] = await itemsOf(w.orgId);
    expect(item).toMatchObject({ options_price: '1.50', total_price: '11.00' });
    expect(item.options).toEqual({
      selected: [
        { group: 'Größe', option: '0,5 l', priceModifier: 1.5 },
        {
          group: 'Zutaten',
          option: 'Zitrone',
          priceModifier: 0,
          excluded: true,
        },
      ],
    });
  });

  it('admin orders reject an option the product does not define', async () => {
    const w = await world();
    await expect(
      ordersService().create(
        w.orgId,
        {
          eventId: w.eventId,
          items: [
            {
              productId: w.bierId,
              quantity: 1,
              selectedOptions: [
                { group: 'Größe', option: 'Freibier', priceModifier: -4 },
              ],
            },
          ],
        },
        user,
      ),
    ).rejects.toMatchObject({
      response: { reason: 'PRODUCT_OPTION_INVALID' },
    });
    expect(await itemsOf(w.orgId)).toEqual([]);
  });

  it('an order without event cannot use a product of another organization', async () => {
    const own = await world();
    const other = await world();
    await sql(`DELETE FROM user_organizations WHERE organization_id = $1`, [
      other.orgId,
    ]);

    await expect(
      ordersService().create(
        own.orgId,
        { items: [{ productId: other.bierId, quantity: 1 }] },
        user,
      ),
    ).rejects.toMatchObject({ response: { reason: 'PRODUCT_NOT_FOUND' } });
    expect(await itemsOf(own.orgId)).toEqual([]);
  });

  it('QR orders price the cart from the product definition', async () => {
    const w = await world();
    const code = `T1-${w.orgId.slice(0, 8)}`;
    await sql(
      `INSERT INTO qr_codes (organization_id, event_id, code, type, table_number)
       VALUES ($1, $2, $3, 'table', '1')`,
      [w.orgId, w.eventId, code],
    );
    const qr = qrService();
    const { sessionToken } = await qr.startSession({ code });

    await expect(
      qr.addToCart(sessionToken, {
        productId: w.bierId,
        quantity: 1,
        options: [{ group: 'Rabatt', option: '100 %', priceModifier: -4 }],
      }),
    ).rejects.toMatchObject({
      response: { reason: 'PRODUCT_OPTION_INVALID' },
    });

    await qr.addToCart(sessionToken, {
      productId: w.bierId,
      quantity: 1,
      options: [{ group: 'Größe', option: '0,5 l', priceModifier: -5.5 }],
    });
    // Ein schon gespeicherter Warenkorb mit veraendertem Preis wird beim
    // Absenden neu bewertet.
    await sql(
      `UPDATE online_order_sessions
          SET cart = jsonb_set(cart, '{items,0,options,0,priceModifier}', '-5.5')
        WHERE session_token = $1`,
      [sessionToken],
    );
    await qr.submitOrder(sessionToken, {});

    const [item] = await itemsOf(w.orgId);
    expect(item).toMatchObject({ options_price: '1.50', total_price: '5.50' });
  });

  it('shop checkouts charge option prices from the product definition', async () => {
    const w = await world();
    const sumup = {
      createOnlineCheckout: jest.fn(() =>
        Promise.resolve({ id: 'chk-1', checkoutUrl: 'https://pay.example/1' }),
      ),
    };
    const shop = new EventsShopCheckoutController(
      ds.getRepository(Event),
      ds.getRepository(Organization),
      ds.getRepository(Product),
      ds.getRepository(Category),
      ds.getRepository(Order),
      ds.getRepository(OrderItem),
      ds.getRepository(Payment),
      ds.getRepository(ShopCheckout),
      sumup as never,
      {} as never,
      print as never,
      config as never,
      gateway as never,
    );
    const body = (priceModifier: number, option = '0,5 l') => ({
      email: 'gast@example.org',
      customerName: { firstName: 'Gast' },
      items: [
        {
          productId: w.bierId,
          quantity: 2,
          options: [{ group: 'Größe', option, priceModifier }],
        },
      ],
    });

    await shop.createCheckout(w.eventId, body(0));
    await expect(
      shop.createCheckout(w.eventId, body(0, '1 l')),
    ).rejects.toMatchObject({
      response: { reason: 'PRODUCT_OPTION_INVALID' },
    });

    expect(sumup.createOnlineCheckout).toHaveBeenCalledTimes(1);
    expect(sumup.createOnlineCheckout).toHaveBeenCalledWith(
      'sup_sk_test',
      'MCODE',
      expect.objectContaining({ amount: 11 }),
    );
    const [checkout] = await sql(
      `SELECT total_amount, items FROM shop_checkouts WHERE organization_id = $1`,
      [w.orgId],
    );
    expect(checkout.total_amount).toBe('11.00');
  });
});
