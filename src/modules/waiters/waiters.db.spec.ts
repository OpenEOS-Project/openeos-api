import { randomUUID } from 'crypto';
import * as path from 'path';
import * as bcrypt from 'bcrypt';
import { HttpException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Device, User } from '../../database/entities';
import { ErrorReasons } from '../../common/constants/error-codes';
import { PinCredentialsService } from './pin-credentials.service';
import { PinLockoutService } from './pin-lockout.service';
import { WaiterSessionsService } from './waiter-sessions.service';
import { WaitersService } from './waiters.service';

/**
 * Bedienungen gegen ein echtes Postgres: PIN-Raum (HMAC, Eindeutigkeit),
 * Nachziehen alter Mitglieds-PINs, Sitzungen (Geraet, Ablauf, Wechsel,
 * Veranstaltung), Sperre, Grenzen, Rechte und Mandantentrennung.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:55440/openeos_waiters_test pnpm test waiters.db
 *
 * Name muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

/** Redis faellt aus → die Sperre zaehlt im Speicher (wie im Betrieb). */
const offlineRedis = new Proxy(
  {},
  { get: () => () => Promise.reject(new Error('redis offline (test)')) },
);

async function reasonOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return (error.getResponse() as { reason?: string }).reason ?? null;
  }
}

describeWithDb('Bedienungen against Postgres', () => {
  let ds: DataSource;
  let pins: PinCredentialsService;
  let lockout: PinLockoutService;
  let sessions: WaiterSessionsService;
  let waiters: WaitersService;
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const config = (values: Record<string, unknown>) =>
    ({ get: (key: string) => values[key] }) as never;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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
    pins = new PinCredentialsService(
      ds,
      config({ PIN_PEPPER: 'db-spec-pepper-0123456789abcdef' }),
    );
    lockout = new PinLockoutService(offlineRedis as never, ds);
    sessions = new WaiterSessionsService(ds, pins, lockout);
    sessions.minResponseMs = 0;
    waiters = new WaitersService(
      ds,
      pins,
      sessions,
      config({ 'limits.waitersPerOrganization': 200 }),
    );
  }, 120_000);

  afterAll(async () => {
    if (ds?.isInitialized) {
      if (orgIds.length) {
        await ds.query(
          `DELETE FROM orders WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
        await ds.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
          orgIds,
        ]);
      }
      if (userIds.length) {
        await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
          userIds,
        ]);
      }
      await ds.destroy();
    }
  });

  async function org(waiterLimit: number | null = null): Promise<string> {
    const id = randomUUID();
    orgIds.push(id);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin, settings, country, operating_mode, waiter_limit)
       VALUES ($1, 'Feuerwehr', $2, '123456', '{}', 'DE', 'full', $3)`,
      [id, `ff-${id}`, waiterLimit],
    );
    return id;
  }

  async function event(orgId: string, status: string): Promise<string> {
    const [row] = await ds.query<{ id: string }[]>(
      `INSERT INTO events (organization_id, name, start_date, end_date, status)
       VALUES ($1, 'Sommerfest', now(), now() + interval '1 day', $2) RETURNING id`,
      [orgId, status],
    );
    return row.id;
  }

  async function device(
    orgId: string,
    settings: Record<string, unknown> = { waiterMode: 'shared' },
  ): Promise<Device> {
    const [row] = await ds.query<{ id: string }[]>(
      `INSERT INTO devices (organization_id, name, type, device_token, settings, status)
       VALUES ($1, 'Kasse', 'pos', $2, $3, 'verified') RETURNING id`,
      [orgId, `tok-${randomUUID()}`, JSON.stringify(settings)],
    );
    return {
      id: row.id,
      organizationId: orgId,
      name: 'Kasse',
      settings,
    } as unknown as Device;
  }

  async function member(
    orgId: string,
    options: {
      role?: 'admin' | 'member';
      permissions?: Record<string, boolean>;
      legacyPin?: string;
    } = {},
  ): Promise<{ user: User; membershipId: string }> {
    const id = randomUUID();
    userIds.push(id);
    await ds.query(
      `INSERT INTO users (id, email, first_name, last_name) VALUES ($1, $2, 'Markus', 'Maier')`,
      [id, `w-${id}@example.com`],
    );
    const [row] = await ds.query<{ id: string }[]>(
      `INSERT INTO user_organizations (user_id, organization_id, role, permissions, pin)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        id,
        orgId,
        options.role ?? 'admin',
        JSON.stringify(options.permissions ?? {}),
        options.legacyPin ? await bcrypt.hash(options.legacyPin, 4) : null,
      ],
    );
    return { user: { id } as User, membershipId: row.id };
  }

  it('stores only an HMAC and keeps one PIN space per organization (members and servers)', async () => {
    const orgId = await org();
    const { user: admin, membershipId } = await member(orgId);
    const anna = await waiters.create(
      orgId,
      { name: 'Anna Berger', pin: '3958' },
      admin,
    );
    expect(anna.pin).toBe('3958');
    const [row] = await ds.query<{ pin_lookup: string; pin_length: number }[]>(
      `SELECT pin_lookup, pin_length FROM pin_credentials WHERE owner_id = $1`,
      [anna.id],
    );
    expect(row.pin_lookup).toMatch(/^[0-9a-f]{64}$/);
    expect(row.pin_lookup).not.toContain('3958');
    expect(row.pin_length).toBe(4);

    // Vergeben (Bedienung oder Mitglied) oder zu einfach → PIN_NOT_AVAILABLE.
    expect(
      await reasonOf(
        waiters.create(orgId, { name: 'Ben', pin: '3958' }, admin),
      ),
    ).toBe(ErrorReasons.PIN_NOT_AVAILABLE);
    expect(
      await reasonOf(
        pins.assign(
          orgId,
          { ownerType: 'member', ownerId: membershipId },
          '3958',
        ),
      ),
    ).toBe(ErrorReasons.PIN_NOT_AVAILABLE);
    expect(
      await reasonOf(
        waiters.create(orgId, { name: 'Ben', pin: '1234' }, admin),
      ),
    ).toBe(ErrorReasons.PIN_NOT_AVAILABLE);
    // Die Datenbank erzwingt die Eindeutigkeit auch ohne Vorpruefung.
    await expect(
      ds.query(
        `INSERT INTO pin_credentials (organization_id, owner_type, owner_id, pin_lookup, pepper_id, pin_length)
         VALUES ($1, 'waiter', $2, $3, 'deadbeef', 4)`,
        [orgId, randomUUID(), row.pin_lookup],
      ),
    ).rejects.toThrow(/UQ_pin_credentials_lookup|duplicate/);

    // Dieselbe PIN in einer anderen Organisation ist frei.
    const other = await org();
    const { user: otherAdmin } = await member(other);
    await expect(
      waiters.create(other, { name: 'Anna', pin: '3958' }, otherAdmin),
    ).resolves.toMatchObject({ pin: '3958' });
  });

  it('generates unique PINs in bulk, shows them once and never lists them', async () => {
    const orgId = await org();
    const { user: admin } = await member(orgId);
    const evt = await event(orgId, 'active');
    const created = await waiters.bulkCreate(
      orgId,
      {
        eventId: evt,
        items: Array.from({ length: 40 }, (_, i) => ({
          name: `Helfer ${i + 1}`,
        })),
      },
      admin,
    );
    const pinsOnce = created.map((w) => w.pin);
    expect(new Set(pinsOnce).size).toBe(40);
    for (const pin of pinsOnce) expect(pin).toMatch(/^\d{4}$/);
    const list = await waiters.list(orgId, admin, { eventId: evt });
    expect(list.data).toHaveLength(40);
    expect(list.meta).toMatchObject({ limit: 200, count: 40, pinLength: 4 });
    for (const w of list.data) {
      expect(w).not.toHaveProperty('pin');
      expect(w).toMatchObject({ hasPin: true, eventId: evt, role: 'service' });
    }
    // 6-stellig, wenn die Organisation es so will.
    await ds.query(
      `UPDATE organizations SET settings = '{"waiters":{"pinLength":6}}' WHERE id = $1`,
      [orgId],
    );
    const six = await waiters.create(orgId, { name: 'Lange PIN' }, admin);
    expect(six.pin).toMatch(/^\d{6}$/);
  });

  it('migrates a member bcrypt PIN lazily on first use and clears the old hash', async () => {
    const orgId = await org();
    const { user: admin } = await member(orgId);
    const { membershipId } = await member(orgId, {
      role: 'member',
      permissions: { orders: true },
      legacyPin: '7146',
    });
    // Vor dem Nachziehen: die alte PIN ist trotzdem vergeben.
    expect(
      await reasonOf(waiters.create(orgId, { name: 'X', pin: '7146' }, admin)),
    ).toBe(ErrorReasons.PIN_NOT_AVAILABLE);

    const pos = await device(orgId);
    const login = await sessions.login(pos, '7146');
    expect(login).toMatchObject({
      kind: 'member',
      waiter: {
        kind: 'member',
        name: 'Markus Maier',
        permissions: { refund: true },
      },
    });
    const [membership] = await ds.query<{ pin: string | null }[]>(
      `SELECT pin FROM user_organizations WHERE id = $1`,
      [membershipId],
    );
    expect(membership.pin).toBeNull();
    const [credential] = await ds.query<{ owner_type: string }[]>(
      `SELECT owner_type FROM pin_credentials WHERE owner_id = $1`,
      [membershipId],
    );
    expect(credential.owner_type).toBe('member');
    // Danach direkt ueber den Pruefwert.
    await expect(sessions.login(pos, '7146')).resolves.toMatchObject({
      kind: 'member',
    });
    expect(
      await reasonOf(waiters.create(orgId, { name: 'X', pin: '7146' }, admin)),
    ).toBe(ErrorReasons.PIN_NOT_AVAILABLE);
  });

  it('binds the session token to the device, ends it on switch and when idle', async () => {
    const orgId = await org();
    const { user: admin } = await member(orgId);
    const anna = await waiters.create(
      orgId,
      { name: 'Anna Berger', shortName: 'Anna' },
      admin,
    );
    const ben = await waiters.create(orgId, { name: 'Ben Krämer' }, admin);
    const kasse1 = await device(orgId);
    const kasse2 = await device(orgId);

    const s1 = await sessions.login(kasse1, anna.pin);
    expect(s1.token).toBeDefined();
    const [stored] = await ds.query<{ token_hash: string }[]>(
      `SELECT token_hash FROM waiter_sessions WHERE id = $1`,
      [s1.sessionId],
    );
    expect(stored.token_hash).not.toBe(s1.token);
    const operator = await sessions.operatorForRequest(kasse1, s1.token);
    expect(operator).toMatchObject({
      kind: 'waiter',
      waiterId: anna.id,
      shortName: 'Anna',
    });

    // Token an einem anderen Geraet: abgelaufen (403), nicht angemeldet.
    expect(await reasonOf(sessions.operatorForRequest(kasse2, s1.token))).toBe(
      ErrorReasons.WAITER_SESSION_EXPIRED,
    );
    // Gemeinsame Kasse ohne Token: Pflicht.
    expect(await reasonOf(sessions.operatorForRequest(kasse1, undefined))).toBe(
      ErrorReasons.WAITER_SESSION_REQUIRED,
    );
    // Modus aus: ohne Token wie bisher.
    const off = await device(orgId, {});
    await expect(
      sessions.operatorForRequest(off, undefined),
    ).resolves.toBeNull();

    // Wechsel: Ben meldet sich an derselben Kasse an, Annas Sitzung endet.
    const s2 = await sessions.login(kasse1, ben.pin);
    const ended = await ds.query<{ end_reason: string }[]>(
      `SELECT end_reason FROM waiter_sessions WHERE id = $1`,
      [s1.sessionId],
    );
    expect(ended[0].end_reason).toBe('switch');
    expect(await reasonOf(sessions.operatorForRequest(kasse1, s1.token))).toBe(
      ErrorReasons.WAITER_SESSION_EXPIRED,
    );

    // Inaktiv: automatische Sperre 120 s (+60 s Puffer).
    const locking = await device(orgId, {
      waiterMode: 'shared',
      autoLockSeconds: 120,
    });
    const s3 = await sessions.login(locking, anna.pin);
    await ds.query(
      `UPDATE waiter_sessions SET last_seen_at = now() - interval '5 minutes' WHERE id = $1`,
      [s3.sessionId],
    );
    expect(await reasonOf(sessions.operatorForRequest(locking, s3.token))).toBe(
      ErrorReasons.WAITER_SESSION_EXPIRED,
    );
    const timedOut = await ds.query<{ end_reason: string }[]>(
      `SELECT end_reason FROM waiter_sessions WHERE id = $1`,
      [s3.sessionId],
    );
    expect(timedOut[0].end_reason).toBe('timeout');
    // Ohne automatische Sperre: 12 h.
    await ds.query(
      `UPDATE waiter_sessions SET last_seen_at = now() - interval '13 hours' WHERE id = $1`,
      [s2.sessionId],
    );
    expect(await reasonOf(sessions.operatorForRequest(kasse1, s2.token))).toBe(
      ErrorReasons.WAITER_SESSION_EXPIRED,
    );

    // Abmelden per Token.
    const s4 = await sessions.login(kasse2, ben.pin);
    await expect(sessions.end(kasse2, s4.token, 'lock')).resolves.toBe(true);
    await expect(sessions.current(kasse2, s4.token)).resolves.toBeNull();
  });

  it('deactivating or a new PIN ends the sessions; the old PIN stops working', async () => {
    const orgId = await org();
    const { user: admin } = await member(orgId);
    const anna = await waiters.create(orgId, { name: 'Anna' }, admin);
    const pos = await device(orgId);
    const s1 = await sessions.login(pos, anna.pin);

    const { pin: newPin } = await waiters.resetPin(
      orgId,
      anna.id,
      undefined,
      admin,
    );
    expect(newPin).not.toBe(anna.pin);
    expect(await reasonOf(sessions.operatorForRequest(pos, s1.token))).toBe(
      ErrorReasons.WAITER_SESSION_EXPIRED,
    );
    expect(await reasonOf(sessions.login(pos, anna.pin))).toBe(
      ErrorReasons.PIN_INVALID,
    );
    const s2 = await sessions.login(pos, newPin);

    await waiters.update(orgId, anna.id, { isActive: false }, admin);
    expect(await reasonOf(sessions.operatorForRequest(pos, s2.token))).toBe(
      ErrorReasons.WAITER_SESSION_EXPIRED,
    );
    expect(await reasonOf(sessions.login(pos, newPin))).toBe(
      ErrorReasons.PIN_INVALID,
    );
    const [view] = (await waiters.list(orgId, admin)).data;
    expect(view).toMatchObject({ isActive: false, hasPin: false });
  });

  it('event servers only work while their event is active or in test', async () => {
    const orgId = await org();
    const { user: admin } = await member(orgId);
    const evt = await event(orgId, 'inactive');
    const helper = await waiters.create(
      orgId,
      { name: 'Helfer', eventId: evt },
      admin,
    );
    const pos = await device(orgId);
    expect(await reasonOf(sessions.login(pos, helper.pin))).toBe(
      ErrorReasons.WAITER_NOT_FOR_EVENT,
    );
    await ds.query(`UPDATE events SET status = 'test' WHERE id = $1`, [evt]);
    const session = await sessions.login(pos, helper.pin);
    await ds.query(`UPDATE events SET status = 'inactive' WHERE id = $1`, [
      evt,
    ]);
    expect(
      await reasonOf(sessions.operatorForRequest(pos, session.token)),
    ).toBe(ErrorReasons.WAITER_SESSION_EXPIRED);
  });

  it('personal devices book as their fixed server, without a token', async () => {
    const orgId = await org();
    const { user: admin } = await member(orgId);
    const anna = await waiters.create(orgId, { name: 'Anna' }, admin);
    const handy = await device(orgId, {
      waiterMode: 'personal',
      waiterId: anna.id,
    });
    await expect(
      sessions.operatorForRequest(handy, undefined),
    ).resolves.toMatchObject({
      waiterId: anna.id,
    });
    await waiters.update(orgId, anna.id, { isActive: false }, admin);
    expect(await reasonOf(sessions.operatorForRequest(handy, undefined))).toBe(
      ErrorReasons.WAITER_DEVICE_UNASSIGNED,
    );
  });

  it('separates organizations: foreign servers, PINs and devices', async () => {
    const orgA = await org();
    const orgB = await org();
    const { user: adminA } = await member(orgA);
    const { user: adminB } = await member(orgB);
    const inB = await waiters.create(orgB, { name: 'Fremd' }, adminB);
    expect(
      await reasonOf(
        waiters.update(orgA, inB.id, { name: 'Gekapert' }, adminA),
      ),
    ).toBe(ErrorReasons.WAITER_NOT_FOUND);
    expect(
      await reasonOf(waiters.resetPin(orgA, inB.id, undefined, adminA)),
    ).toBe(ErrorReasons.WAITER_NOT_FOUND);
    expect(await reasonOf(waiters.list(orgB, adminA))).toBe(
      ErrorReasons.ORGANIZATION_ACCESS_DENIED,
    );
    const posA = await device(orgA);
    expect(await reasonOf(sessions.login(posA, inB.pin))).toBe(
      ErrorReasons.PIN_INVALID,
    );
    // Token einer Sitzung in B gilt an keinem Geraet in A.
    const posB = await device(orgB);
    const sB = await sessions.login(posB, inB.pin);
    expect(await reasonOf(sessions.operatorForRequest(posA, sB.token))).toBe(
      ErrorReasons.WAITER_SESSION_EXPIRED,
    );
  });

  it('needs the admin role or the "waiters" permission', async () => {
    const orgId = await org();
    const { user: plain } = await member(orgId, {
      role: 'member',
      permissions: {},
    });
    const { user: allowed } = await member(orgId, {
      role: 'member',
      permissions: { waiters: true },
    });
    expect(await reasonOf(waiters.create(orgId, { name: 'X' }, plain))).toBe(
      ErrorReasons.INSUFFICIENT_PERMISSIONS,
    );
    await expect(
      waiters.create(orgId, { name: 'X' }, allowed),
    ).resolves.toMatchObject({
      name: 'X',
    });
  });

  it('caps servers per organization (own limit, not counted as members)', async () => {
    const orgId = await org(3);
    const { user: admin } = await member(orgId);
    expect(
      await reasonOf(
        waiters.bulkCreate(
          orgId,
          {
            items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
          },
          admin,
        ),
      ),
    ).toBe(ErrorReasons.WAITER_LIMIT_REACHED);
    await waiters.bulkCreate(
      orgId,
      { items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
      admin,
    );
    expect(await reasonOf(waiters.create(orgId, { name: 'd' }, admin))).toBe(
      ErrorReasons.WAITER_LIMIT_REACHED,
    );
    const [{ count }] = await ds.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM user_organizations WHERE organization_id = $1`,
      [orgId],
    );
    expect(count).toBe(1);
  });

  it('deletes unused servers and anonymizes servers with bookings', async () => {
    const orgId = await org();
    const { user: admin } = await member(orgId);
    const unused = await waiters.create(orgId, { name: 'Ungenutzt' }, admin);
    const busy = await waiters.create(
      orgId,
      { name: 'Anna Berger', shortName: 'Anna' },
      admin,
    );
    await ds.query(
      `INSERT INTO orders (organization_id, order_number, daily_number, created_by_waiter_id, waiter_id)
       VALUES ($1, 'W-1', 1, $2, $2)`,
      [orgId, busy.id],
    );
    await expect(waiters.remove(orgId, unused.id, admin)).resolves.toEqual({
      deleted: true,
      anonymized: false,
    });
    await expect(waiters.remove(orgId, busy.id, admin)).resolves.toEqual({
      deleted: false,
      anonymized: true,
    });
    const [row] = await ds.query<
      {
        name: string;
        short_name: string | null;
        is_active: boolean;
        anonymized_at: Date | null;
      }[]
    >(
      `SELECT name, short_name, is_active, anonymized_at FROM waiters WHERE id = $1`,
      [busy.id],
    );
    expect(row).toMatchObject({
      name: 'Bedienung 1',
      short_name: null,
      is_active: false,
    });
    expect(row.anonymized_at).not.toBeNull();
    // Die Bestellung behaelt ihre Zuordnung.
    const [order] = await ds.query<{ waiter_id: string }[]>(
      `SELECT waiter_id FROM orders WHERE organization_id = $1`,
      [orgId],
    );
    expect(order.waiter_id).toBe(busy.id);
  });

  it('locks PIN entry on a device after five wrong PINs (same answer for every wrong PIN)', async () => {
    const orgId = await org();
    const pos = await device(orgId);
    const reasons: Array<string | null> = [];
    for (let i = 0; i < 5; i += 1) {
      reasons.push(await reasonOf(sessions.login(pos, `50${20 + i}`)));
    }
    expect(reasons).toEqual(Array(5).fill(ErrorReasons.PIN_INVALID));
    expect(await reasonOf(sessions.login(pos, '5099'))).toBe(
      ErrorReasons.PIN_LOCKED,
    );
  });

  it('a changed pepper invalidates stored PINs instead of matching wrong owners', async () => {
    const orgId = await org();
    const { user: admin } = await member(orgId);
    const anna = await waiters.create(orgId, { name: 'Anna' }, admin);
    const rotated = new PinCredentialsService(
      ds,
      config({ PIN_PEPPER: 'another-pepper-0123456789abcdef' }),
    );
    await expect(rotated.resolve(orgId, anna.pin)).resolves.toBeNull();
    await expect(rotated.ownersWithPin('waiter', [anna.id])).resolves.toEqual(
      new Set(),
    );
    await expect(pins.ownersWithPin('waiter', [anna.id])).resolves.toEqual(
      new Set([anna.id]),
    );
  });
});
