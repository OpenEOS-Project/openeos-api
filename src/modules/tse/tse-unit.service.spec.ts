import { Logger } from '@nestjs/common';

import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import type { TseUnit } from '../../database/entities/tse-unit.entity';
import type { User } from '../../database/entities/user.entity';
import {
  SwissbitRequestError,
  SwissbitUnavailableError,
} from './swissbit/swissbit.errors';
import { berlinTime } from './tse-dates';
import { TseUnitService } from './tse-unit.service';

const ORG = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a99';
const admin = { id: 'user-1', isSuperAdmin: false } as User;
const superAdmin = { id: 'root', isSuperAdmin: true } as User;

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

interface Fixture {
  country?: string;
  integration?: boolean;
  events?: Array<{
    id: string;
    name: string;
    startDate: Date;
    endDate: Date | null;
  }>;
  mode?: string;
  /** false = ohne Steuernummer/Anschrift (DSFinV-K-Stammdaten). */
  masterData?: boolean;
}

function chain(result: () => unknown) {
  const qb: Record<string, unknown> = {};
  for (const name of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'innerJoin',
    'leftJoinAndSelect',
  ]) {
    qb[name] = jest.fn(() => qb);
  }
  qb.getOne = jest.fn(() => {
    const value = result();
    return Promise.resolve(Array.isArray(value) ? (value[0] ?? null) : value);
  });
  qb.getMany = jest.fn(() => {
    const value = result();
    return Promise.resolve(Array.isArray(value) ? value : value ? [value] : []);
  });
  return qb;
}

function setup(fixture: Fixture = {}) {
  const units = new Map<string, TseUnit>();
  const audit: Array<{ action: string; details: unknown }> = [];
  const sql: string[] = [];
  const organization = {
    id: ORG,
    country: fixture.country ?? 'DE',
    settings: {
      integrations: { tse: { enabled: fixture.integration ?? true } },
      ...(fixture.masterData === false
        ? {}
        : {
            taxNumber: '12/345/67890',
            contact: {
              address: 'Sportplatzweg 1',
              zipCode: '12345',
              city: 'Musterdorf',
            },
          }),
    },
    operatingMode: fixture.mode ?? 'cashless',
  };
  let seq = 0;
  const current = () => [...units.values()][0] ?? null;
  const merge = (id: string, patch: Partial<TseUnit>) => {
    units.set(id, { ...units.get(id)!, ...patch });
  };
  const unitRepository = {
    create: jest.fn((data: Partial<TseUnit>) => ({ ...data })),
    save: jest.fn((data: TseUnit) => {
      const defaults: Partial<TseUnit> = {
        attempts: 0,
        createdAt: new Date(),
        clientRegisteredAt: null,
        serialNumber: null,
        accessTokenEnc: null,
        creationId: null,
        activatedAt: null,
      };
      const unit = Object.assign(defaults, data, {
        id: data.id ?? `unit-${++seq}`,
      }) as TseUnit;
      units.set(unit.id, unit);
      return Promise.resolve(unit);
    }),
    update: jest.fn((id: string, patch: Partial<TseUnit>) => {
      merge(id, patch);
      return Promise.resolve();
    }),
    findOne: jest.fn(() => {
      const unit = current();
      return Promise.resolve(
        unit && ['creating', 'active'].includes(unit.state) ? unit : unit,
      );
    }),
    find: jest.fn(() => Promise.resolve([...units.values()])),
    query: jest.fn((text: string, params: unknown[]) => {
      sql.push(text);
      if (text.includes('job_locked_until = now()')) {
        const unit = units.get(params[0] as string);
        return Promise.resolve(
          unit?.state === 'creating' ? [[{ id: unit.id }], 1] : [[], 0],
        );
      }
      return Promise.resolve([[], 0]);
    }),
    createQueryBuilder: jest.fn(() => chain(current)),
  };
  const manager = {
    update: jest.fn((_entity: unknown, id: string, patch: Partial<TseUnit>) => {
      merge(id, patch);
      return Promise.resolve();
    }),
    query: jest.fn((text: string) => {
      sql.push(text);
      if (text.includes("operating_mode = 'cashless'")) {
        return Promise.resolve(
          organization.operatingMode === 'cashless'
            ? [[{ id: ORG }], 1]
            : [[], 0],
        );
      }
      return Promise.resolve([[], 0]);
    }),
    insert: jest.fn(() => Promise.resolve()),
  };
  const dataSource = {
    transaction: jest.fn((cb: (m: typeof manager) => unknown) =>
      Promise.resolve(cb(manager)),
    ),
    getRepository: jest.fn(() => ({
      create: (x: { action: string; details: unknown }) => x,
      save: (x: { action: string; details: unknown }) => {
        audit.push(x);
        return Promise.resolve(x);
      },
    })),
    query: jest.fn(() => Promise.resolve([])),
  };
  const client = {
    createTse: jest.fn(() =>
      Promise.resolve({
        value: { creationId: 'job-1' },
        requestId: 'r',
        durationMs: 1,
      }),
    ),
    creationStatus: jest
      .fn()
      .mockResolvedValueOnce({
        value: {
          status: 'pending',
          tseSerialNumber: null,
          tseAccessToken: null,
        },
        requestId: 'r',
        durationMs: 1,
      })
      .mockResolvedValue({
        value: {
          status: 'success',
          tseSerialNumber: 'ff00',
          tseAccessToken: 'plain-token',
          errorCode: null,
          errorMessage: null,
        },
        requestId: 'r',
        durationMs: 1,
      }),
    info: jest.fn(() =>
      Promise.resolve({
        value: {
          serialNumber: 'ff00',
          publicKey: 'PK',
          signatureAlgorithm: 'ecdsa-plain-SHA256',
          logTimeFormat: 'unixTime',
          certificationId: 'BSI-K-TR-0000',
          certificateExpirationDate: 2046124799,
        },
        requestId: 'r',
        durationMs: 1,
      }),
    ),
    registerClient: jest.fn(() =>
      Promise.resolve({ value: null, requestId: 'r', durationMs: 1 }),
    ),
    disableSecureElement: jest.fn(() =>
      Promise.resolve({ value: null, requestId: 'r', durationMs: 1 }),
    ),
  };
  const notify = {
    notifyAdmins: jest.fn(() => Promise.resolve()),
    statusChanged: jest.fn(),
    settingsChanged: jest.fn(),
  };
  const cache = { invalidate: jest.fn() };
  const eventRepository = {
    createQueryBuilder: jest.fn(() => chain(() => fixture.events ?? [])),
  };
  const service = new TseUnitService(
    unitRepository as never,
    { findOne: jest.fn(() => Promise.resolve(organization)) } as never,
    { findOne: jest.fn(() => Promise.resolve({ role: 'admin' })) } as never,
    eventRepository as never,
    { query: jest.fn(() => Promise.resolve([])) } as never,
    dataSource as never,
    {
      enabled: true,
      lifecycle: 'persistent',
      settings: { swissbit: { productType: '850007' }, timeouts: {} },
    } as never,
    {
      client,
      credit: { clientId: 'c', secret: 's' },
      hasVendorCredentials: true,
    } as never,
    {
      encrypt: (s: string) => `enc:${s}`,
      decrypt: (s: string) => s.replace(/^enc:/, ''),
    } as never,
    cache as never,
    notify as never,
    {} as never,
    { runExclusive: jest.fn() } as never,
    { isSelfHosted: false } as never,
  );
  service.pollDelays = { firstMs: 0, nextMs: 0 };
  // Anlage im Hintergrund in Tests ausdruecklich anstossen.
  const advance = jest.spyOn(service, 'advance');
  currentAdvance = advance;
  return {
    service,
    units,
    audit,
    sql,
    client,
    notify,
    cache,
    organization,
    advance,
    manager,
  };
}

const paidEvent = (start: Date, end: Date | null = null) => ({
  id: 'event-1',
  name: 'Sommerfest',
  startDate: start,
  endDate: end ?? new Date(start.getTime() + 2 * 24 * 3600_000),
});

/** Wartet, bis alle im Hintergrund gestarteten Anlage-Schritte fertig sind. */
let currentAdvance: jest.SpyInstance | null = null;
async function flush() {
  let seen = -1;
  while (currentAdvance && seen !== currentAdvance.mock.results.length) {
    seen = currentAdvance.mock.results.length;
    await Promise.all(
      currentAdvance.mock.results.map((r) => r.value as Promise<void>),
    );
  }
}

describe('TseUnitService — Anlage (Zustandsmaschine)', () => {
  it('creating → Swissbit fertig → Status → Client → active', async () => {
    const f = setup({ events: [paidEvent(new Date(Date.now() - 3600_000))] });
    const unit = await f.service.requestCreation(ORG, admin, {}, {});
    expect(unit.state).toBe('creating');
    expect(unit.clientId).toBe('OEOS-7D0C7A524F43');
    expect(unit.trigger).toBe('manual');
    expect(unit.triggerEventId).toBe('event-1');
    await flush();

    const stored = [...f.units.values()][0];
    expect(f.client.createTse).toHaveBeenCalledWith(
      { clientId: 'c', secret: 's' },
      expect.objectContaining({ productType: '850007' }),
    );
    expect(f.client.creationStatus).toHaveBeenCalledTimes(2);
    expect(stored).toMatchObject({
      state: 'active',
      serialNumber: 'ff00',
      accessTokenEnc: 'enc:plain-token',
      publicKey: 'PK',
      signatureAlgorithm: 'ecdsa-plain-SHA256',
      logTimeFormat: 'unixTime',
    });
    expect(stored.certificateExpiresAt?.toISOString()).toBe(
      new Date(2046124799 * 1000).toISOString(),
    );
    expect(f.client.registerClient).toHaveBeenCalledWith(
      { serialNumber: 'ff00', accessToken: 'plain-token' },
      'OEOS-7D0C7A524F43',
    );
    expect(f.sql.some((q) => q.includes('SET tse_active = true'))).toBe(true);
    // „Bargeldlos“ → „Alle Funktionen“, protokolliert
    expect(f.manager.insert).toHaveBeenCalled();
    expect(f.audit.map((a) => a.action)).toEqual([
      AdminAction.TSE_CREATION_REQUESTED,
      AdminAction.TSE_ACTIVATED,
    ]);
    expect(f.cache.invalidate).toHaveBeenCalledWith(ORG);
    expect(f.notify.notifyAdmins).toHaveBeenCalledWith(
      ORG,
      'activated',
      expect.any(Array),
    );
  });

  it('stores the access token before any further step (Swissbit returns it only once)', async () => {
    const f = setup({ events: [paidEvent(new Date())] });
    f.client.info.mockRejectedValueOnce(
      new SwissbitUnavailableError({
        operation: 'info',
        status: 503,
        errorCode: 'E_MAINTENANCE_IN_PROGRESS',
        message: '',
        requestId: 'r',
      }),
    );
    await f.service.requestCreation(ORG, admin, {}, {});
    await flush();
    const stored = [...f.units.values()][0];
    expect(stored).toMatchObject({
      state: 'creating',
      accessTokenEnc: 'enc:plain-token',
      serialNumber: 'ff00',
    });
    expect(stored.attempts).toBe(1);

    // Naechster Lauf setzt fort, ohne eine zweite TSE anzulegen.
    await f.service.advance(stored.id);
    expect(f.client.createTse).toHaveBeenCalledTimes(1);
    expect([...f.units.values()][0].state).toBe('active');
  });

  it('treats an already registered client as success', async () => {
    const f = setup({ events: [paidEvent(new Date())] });
    f.client.registerClient.mockRejectedValueOnce(
      new SwissbitRequestError({
        operation: 'registerClient',
        status: 400,
        errorCode: 'E_CLIENT_ALREADY_REGISTERED',
        message: '',
        requestId: 'r',
      }),
    );
    await f.service.requestCreation(ORG, admin, {}, {});
    await flush();
    expect([...f.units.values()][0].state).toBe('active');
  });

  it('marks the unit failed when Swissbit reports a failed creation', async () => {
    const f = setup({ events: [paidEvent(new Date())] });
    f.client.creationStatus.mockReset().mockResolvedValue({
      value: {
        status: 'failure',
        tseSerialNumber: null,
        tseAccessToken: null,
        errorCode: 'E_X',
        errorMessage: 'boom',
      },
      requestId: 'r',
      durationMs: 1,
    });
    await f.service.requestCreation(ORG, admin, {}, {});
    await flush();
    expect([...f.units.values()][0]).toMatchObject({
      state: 'failed',
      lastErrorCode: 'E_X',
    });
    expect(f.audit.map((a) => a.action)).toContain(
      AdminAction.TSE_CREATION_FAILED,
    );
    expect(f.notify.notifyAdmins).toHaveBeenCalledWith(
      ORG,
      'creation_failed',
      expect.any(Array),
    );
  });

  it('is idempotent: a second request returns the running unit', async () => {
    const f = setup({ events: [paidEvent(new Date())] });
    const first = await f.service.requestCreation(ORG, admin, {}, {});
    await flush();
    const second = await f.service.requestCreation(ORG, admin, {}, {});
    expect(second.id).toBe(first.id);
    expect(f.client.createTse).toHaveBeenCalledTimes(1);
  });
});

describe('TseUnitService — Kostenregeln vor der Anlage', () => {
  it('only for Germany', async () => {
    const f = setup({ country: 'AT', events: [paidEvent(new Date())] });
    await expect(
      f.service.requestCreation(ORG, admin, {}, {}),
    ).rejects.toMatchObject({
      response: { code: 'TSE_COUNTRY_NOT_SUPPORTED' },
    });
  });

  it('only with the integration switched on', async () => {
    const f = setup({ integration: false, events: [paidEvent(new Date())] });
    await expect(
      f.service.requestCreation(ORG, admin, {}, {}),
    ).rejects.toMatchObject({
      response: { code: 'INTEGRATION_DISABLED' },
    });
  });

  it('needs the tax number and address for the DSFinV-K first', async () => {
    const f = setup({ masterData: false });
    await expect(
      f.service.requestCreation(ORG, admin, {}, {}),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'TSE_MASTER_DATA_REQUIRED',
        params: { missing: 'taxNumber,street,zip,city' },
      },
    });
    expect(f.units.size).toBe(0);
  });

  it('needs a paid event that has not ended', async () => {
    const f = setup({ events: [] });
    await expect(
      f.service.requestCreation(ORG, admin, {}, {}),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'TSE_REQUIRES_PAID_EVENT' },
    });
    expect(f.units.size).toBe(0);
  });

  it('not before the calendar month of the event (no empty month billed)', async () => {
    const now = new Date();
    const inTwoMonths = berlinTime(
      now.getUTCFullYear() + (now.getUTCMonth() >= 10 ? 1 : 0),
      ((now.getUTCMonth() + 2) % 12) + 1,
      14,
      18,
    );
    const f = setup({ events: [paidEvent(inTwoMonths)] });
    const error = await f.service
      .requestCreation(ORG, admin, {}, {})
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      status: 409,
      response: { code: 'TSE_TOO_EARLY' },
    });
    const params = (
      error as { response: { params: { availableFrom: string } } }
    ).response.params;
    expect(params.availableFrom).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it('super admins may override with a reason (audited, trigger super_admin)', async () => {
    const f = setup({ events: [] });
    await expect(
      f.service.requestCreation(ORG, superAdmin, { override: true }, {}),
    ).rejects.toMatchObject({
      response: { code: 'TSE_OVERRIDE_REASON_REQUIRED' },
    });
    const unit = await f.service.requestCreation(
      ORG,
      superAdmin,
      { override: true, reason: 'Pilot' },
      {},
    );
    expect(unit).toMatchObject({
      trigger: 'super_admin',
      overrideReason: 'Pilot',
    });
  });

  it('an org admin cannot override', async () => {
    const f = setup({ events: [] });
    await expect(
      f.service.requestCreation(
        ORG,
        admin,
        { override: true, reason: 'bitte' },
        {},
      ),
    ).rejects.toMatchObject({ response: { code: 'TSE_REQUIRES_PAID_EVENT' } });
  });
});

describe('TseUnitService — Deaktivieren', () => {
  it('requires an explicit confirm', async () => {
    const f = setup({ events: [paidEvent(new Date())] });
    await expect(
      f.service.deactivateByUser(ORG, admin, {}, {}),
    ).rejects.toMatchObject({
      response: { code: 'TSE_DEACTIVATION_CONFIRM_REQUIRED' },
    });
  });

  it('disables the secure element, flips tse_active off and switches the integration off', async () => {
    const f = setup({ events: [paidEvent(new Date())] });
    await f.service.requestCreation(ORG, admin, {}, {});
    await flush();
    await f.service.deactivateByUser(
      ORG,
      admin,
      { confirm: true, reason: 'Verein aufgelöst' },
      {},
    );
    expect(f.client.disableSecureElement).toHaveBeenCalledWith({
      serialNumber: 'ff00',
      accessToken: 'plain-token',
    });
    expect([...f.units.values()][0]).toMatchObject({
      state: 'deactivated',
      deactivationReason: 'Verein aufgelöst',
    });
    expect(f.sql.some((q) => q.includes('SET tse_active = false'))).toBe(true);
    expect(f.sql.some((q) => q.includes("'{integrations,tse}'"))).toBe(true);
    expect(f.audit.map((a) => a.action)).toContain(AdminAction.TSE_DEACTIVATED);
  });
});

describe('TseUnitService — Lebenszyklus per_event', () => {
  async function activeUnit(f: ReturnType<typeof setup>, activatedAt: Date) {
    await f.service.requestCreation(
      ORG,
      superAdmin,
      { override: true, reason: 't' },
      {},
    );
    await flush();
    const unit = [...f.units.values()][0];
    f.units.set(unit.id, { ...unit, state: 'active', activatedAt });
  }

  it('deactivates after the last paid event of the month has ended', async () => {
    const now = berlinTime(2026, 7, 21, 6, 30);
    const f = setup({
      events: [
        paidEvent(berlinTime(2026, 7, 18, 12), berlinTime(2026, 7, 19, 23)),
      ],
    });
    await activeUnit(f, berlinTime(2026, 7, 18, 5));
    const due = await f.service.perEventCandidates(now);
    expect(due).toHaveLength(1);
  });

  it('keeps the TSE while a paid event is running (until the business day ends at 6:00)', async () => {
    const now = berlinTime(2026, 7, 20, 5, 30);
    const f = setup({
      events: [
        paidEvent(berlinTime(2026, 7, 18, 12), berlinTime(2026, 7, 19, 23)),
      ],
    });
    await activeUnit(f, berlinTime(2026, 7, 18, 5));
    expect(await f.service.perEventCandidates(now)).toHaveLength(0);
  });

  it('keeps the TSE when another paid event starts later in the same month', async () => {
    const now = berlinTime(2026, 7, 21, 6, 30);
    const f = setup({
      events: [
        paidEvent(berlinTime(2026, 7, 18, 12), berlinTime(2026, 7, 19, 23)),
        { ...paidEvent(berlinTime(2026, 7, 28, 12)), id: 'event-2' },
      ],
    });
    await activeUnit(f, berlinTime(2026, 7, 18, 5));
    expect(await f.service.perEventCandidates(now)).toHaveLength(0);
  });
});
