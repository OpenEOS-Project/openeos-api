import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { EventsService } from './events.service';
import { EventPhaseService } from './event-phase.service';
import { Event, EventStatus } from '../../database/entities/event.entity';
import { Order } from '../../database/entities/order.entity';
import { Organization } from '../../database/entities/organization.entity';
import { DeploymentService } from '../../common/services/deployment.service';
import { GatewayService } from '../gateway/gateway.service';
import { TestOrderCleanupService } from './test-order-cleanup.service';

/**
 * Phasen einer Veranstaltung (2026-11-08): Verschieben nur in „Geplant“,
 * danach Beginn fest, Ende nur vorziehen; Support mit Grund uebersteuert.
 * Dazu die Pruefung neuer Bestellungen (EventPhaseService.prepareOrder).
 *
 * Fest 16.–17.11.2026 (reine Daten), Verkaufsfenster 15.11. 18:00 bis
 * 18.11. 12:00 (Berlin).
 */
const START = '2026-11-15T23:00:00.000Z'; // 16.11. 00:00
const END = '2026-11-16T23:00:00.000Z'; // 17.11. 00:00

function makeEvent(extra: Partial<Event> = {}): Event {
  return {
    id: 'event-1',
    organizationId: 'org-1',
    name: 'Herbstfest',
    status: EventStatus.ACTIVE,
    billingStatus: 'paid',
    billedDays: 2,
    startDate: new Date(START),
    endDate: new Date(END),
    settings: {},
    salesStartedAt: null,
    ...extra,
  } as Event;
}

function setup(
  event: Event,
  options: { billingEnabled?: boolean; orders?: { isTest: boolean }[] } = {},
) {
  const organizationRepository = {
    findOne: jest.fn().mockResolvedValue({
      id: 'org-1',
      settings: { timezone: 'Europe/Berlin' },
      country: 'DE',
      operatingMode: 'full',
    }),
  } as unknown as Repository<Organization>;
  const orders = options.orders ?? [];
  const orderRepository = {
    count: jest.fn(({ where }: { where: { isTest?: boolean } }) =>
      Promise.resolve(
        orders.filter(
          (o) => where.isTest === undefined || o.isTest === where.isTest,
        ).length,
      ),
    ),
  } as unknown as Repository<Order>;
  const eventRepository = {
    findOne: jest.fn().mockResolvedValue(event),
    save: jest.fn((e: Event) => Promise.resolve(e)),
  } as unknown as Repository<Event>;
  const deployment = {
    billingEnabled: options.billingEnabled ?? true,
  } as DeploymentService;
  const config = { get: () => undefined } as unknown as ConfigService;
  const phase = new EventPhaseService(
    config,
    deployment,
    organizationRepository,
    orderRepository,
  );
  const statusChanged = jest.fn<void, [string, { phase?: string }]>();
  const gateway = {
    notifyMenuRefresh: jest.fn(),
    notifyEventStatusChanged: statusChanged,
  } as unknown as GatewayService;
  const unused = {} as never;
  const service = new EventsService(
    eventRepository,
    organizationRepository,
    unused,
    unused,
    unused,
    orderRepository,
    unused,
    unused,
    gateway,
    deployment,
    unused as unknown as TestOrderCleanupService,
    config,
    phase,
  );
  const update = (dto: Record<string, unknown>) =>
    (
      service as unknown as {
        applyUpdate: (
          e: Event,
          d: Record<string, unknown>,
          o: { override: boolean },
        ) => Promise<Event>;
      }
    ).applyUpdate(event, dto, { override: false });
  return { service, phase, update, statusChanged, eventRepository };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return (error as { response: Record<string, unknown> }).response;
  }
  throw new Error('expected an error');
}

describe('EventsService – moving dates by phase', () => {
  afterEach(() => jest.useRealTimers());
  const now = (iso: string) =>
    jest
      .useFakeTimers({ doNotFake: ['nextTick'] })
      .setSystemTime(new Date(iso));

  it('planned: moving by a week is allowed (within the paid days)', async () => {
    now('2026-11-08T12:00:00Z');
    const event = makeEvent();
    const { update } = setup(event);
    await update({
      startDate: '2026-11-22T23:00:00.000Z',
      endDate: '2026-11-23T23:00:00.000Z',
    });
    expect(event.startDate?.toISOString()).toBe('2026-11-22T23:00:00.000Z');
  });

  it('planned: extending beyond the paid days is still refused', async () => {
    now('2026-11-08T12:00:00Z');
    const { update } = setup(makeEvent());
    expect(
      (await failure(update({ endDate: '2026-11-18T23:00:00.000Z' }))).reason,
    ).toBe('EVENT_PAID_DAYS_EXCEEDED');
  });

  it('active: the start is locked', async () => {
    now('2026-11-15T18:00:00Z'); // 19:00, Fenster laeuft
    const { update } = setup(makeEvent());
    const response = await failure(
      update({ startDate: '2026-11-22T23:00:00.000Z' }),
    );
    expect(response.reason).toBe('EVENT_DATES_LOCKED');
    expect(response.params).toMatchObject({ phase: 'active' });
  });

  it('active: the end may be brought forward (one day cancelled)', async () => {
    now('2026-11-16T12:00:00Z');
    const event = makeEvent();
    const { update } = setup(event);
    await update({ endDate: START });
    expect(event.endDate?.toISOString()).toBe(START);
  });

  it('active: the end may not be extended, nor end in the past', async () => {
    now('2026-11-17T12:00:00Z'); // 17.11. 13:00 — der 16. ist vorbei
    const { update } = setup(makeEvent());
    expect(
      (await failure(update({ endDate: '2026-11-17T23:00:00.000Z' }))).reason,
    ).toBe('EVENT_DATES_LOCKED');
    // auf den 16. kuerzen hiesse: Fenster endete am 17. um 12:00 — vorbei
    expect((await failure(update({ endDate: START }))).reason).toBe(
      'EVENT_DATES_LOCKED',
    );
  });

  it('ended: nothing can be moved any more', async () => {
    now('2026-11-20T12:00:00Z');
    const { update } = setup(makeEvent());
    expect((await failure(update({ endDate: START }))).reason).toBe(
      'EVENT_DATES_LOCKED',
    );
  });

  it('paid but never activated (inactive): locked once the window began', async () => {
    now('2026-11-20T12:00:00Z');
    const { update } = setup(makeEvent({ status: EventStatus.INACTIVE }));
    expect(
      (await failure(update({ startDate: '2026-12-05T23:00:00.000Z' }))).reason,
    ).toBe('EVENT_DATES_LOCKED');
  });

  it('name and settings stay editable while active', async () => {
    now('2026-11-16T12:00:00Z');
    const event = makeEvent();
    const { update } = setup(event);
    await update({
      name: 'Herbstfest 2026',
      settings: { sales: { presale: true } },
    });
    expect(event.name).toBe('Herbstfest 2026');
    expect(event.settings.sales).toEqual({ presale: true });
  });

  it('the own early start is locked once the window began', async () => {
    now('2026-11-16T12:00:00Z');
    const { update } = setup(makeEvent());
    expect(
      (await failure(update({ settings: { sales: { earlyStartHours: 24 } } })))
        .reason,
    ).toBe('EVENT_DATES_LOCKED');
  });

  it('validates the early start (0..24) and keeps the other sales fields', async () => {
    now('2026-11-08T12:00:00Z');
    const event = makeEvent({ settings: { sales: { presale: true } } });
    const { update } = setup(event);
    expect(
      (await failure(update({ settings: { sales: { earlyStartHours: 30 } } })))
        .reason,
    ).toBe('EVENT_EARLY_START_INVALID');
    await update({ settings: { sales: { earlyStartHours: 18 } } });
    expect(event.settings.sales).toEqual({
      presale: true,
      earlyStartHours: 18,
    });
    await update({ settings: { sales: { earlyStartHours: null } } });
    expect(event.settings.sales).toEqual({ presale: true });
  });

  it('self-hosted: no lock (no paid duration to protect)', async () => {
    now('2026-11-20T12:00:00Z');
    const event = makeEvent({ billingStatus: 'none' });
    const { update } = setup(event, { billingEnabled: false });
    await update({
      startDate: '2026-11-29T23:00:00.000Z',
      endDate: '2026-11-30T23:00:00.000Z',
    });
    expect(event.endDate?.toISOString()).toBe('2026-11-30T23:00:00.000Z');
  });

  it('support override moves an active event back to planned and reopens the clean-up', async () => {
    now('2026-11-16T12:00:00Z');
    const event = makeEvent({
      salesStartedAt: new Date('2026-11-15T17:00:00Z'),
    });
    const { service, statusChanged } = setup(event);
    const { before } = await service.moveDatesAsSupport(event.id, {
      startDate: '2026-11-22T23:00:00.000Z',
      endDate: '2026-11-23T23:00:00.000Z',
    });
    expect(before.startDate?.toISOString()).toBe(START);
    expect(event.startDate?.toISOString()).toBe('2026-11-22T23:00:00.000Z');
    expect(event.salesStartedAt).toBeNull();
    expect(statusChanged.mock.calls.at(-1)?.[1]).toMatchObject({
      phase: 'planned',
    });
  });
});

describe('EventPhaseService.prepareOrder', () => {
  afterEach(() => jest.useRealTimers());
  const now = (iso: string) =>
    jest
      .useFakeTimers({ doNotFake: ['nextTick'] })
      .setSystemTime(new Date(iso));

  it('planned: POS orders become test orders', async () => {
    now('2026-11-08T12:00:00Z');
    const { phase } = setup(makeEvent());
    const result = await phase.prepareOrder(makeEvent(), 'pos');
    expect(result.plannedTest).toBe(true);
    expect(result.info.phase).toBe('planned');
  });

  it('planned: the test cap (200) counts test orders only', async () => {
    now('2026-11-08T12:00:00Z');
    const orders = [
      ...Array.from({ length: 200 }, () => ({ isTest: true })),
      { isTest: false },
    ];
    const { phase } = setup(makeEvent(), { orders });
    const response = await failure(phase.prepareOrder(makeEvent(), 'table'));
    expect(response.code).toBe('TEST_LIMIT_REACHED');
    expect(response.reason).toBe('PLANNED_TEST_LIMIT_REACHED');
    expect(response.params).toMatchObject({ maxOrders: 200, phase: 'planned' });
  });

  it('planned shop: refused without presale, real with presale', async () => {
    now('2026-11-08T12:00:00Z');
    const { phase } = setup(makeEvent());
    expect(
      (await failure(phase.prepareOrder(makeEvent(), 'shop'))).reason,
    ).toBe('SHOP_PRESALE_DISABLED');
    const presale = makeEvent({ settings: { sales: { presale: true } } });
    expect((await phase.prepareOrder(presale, 'shop')).plannedTest).toBe(false);
  });

  it('active: real orders', async () => {
    now('2026-11-15T17:00:00Z');
    const { phase } = setup(makeEvent());
    expect((await phase.prepareOrder(makeEvent(), 'qr')).plannedTest).toBe(
      false,
    );
  });

  it('ended: 403 EVENT_ENDED on every channel', async () => {
    now('2026-11-18T11:00:00Z');
    const { phase } = setup(makeEvent());
    for (const channel of ['pos', 'table', 'qr', 'shop', 'admin'] as const) {
      const response = await failure(phase.prepareOrder(makeEvent(), channel));
      expect(response.code).toBe('EVENT_ENDED');
    }
    await expect(phase.assertNotEnded(makeEvent())).rejects.toThrow();
  });

  it('inactive: 400 EVENT_NOT_ACTIVE as before', async () => {
    now('2026-11-16T12:00:00Z');
    const { phase } = setup(makeEvent());
    expect(
      (
        await failure(
          phase.prepareOrder(
            makeEvent({ status: EventStatus.INACTIVE }),
            'pos',
          ),
        )
      ).reason,
    ).toBe('EVENT_NOT_ACTIVE');
  });

  it('test mode: the 25-order cap counts all orders, as before', async () => {
    now('2026-11-08T12:00:00Z');
    const orders = Array.from({ length: 25 }, () => ({ isTest: true }));
    const { phase } = setup(makeEvent(), { orders });
    const response = await failure(
      phase.prepareOrder(
        makeEvent({ status: EventStatus.TEST, billingStatus: 'none' }),
        'pos',
      ),
    );
    expect(response.code).toBe('TEST_LIMIT_REACHED');
  });

  it('isTestModeNow: test status and planned phase', async () => {
    now('2026-11-08T12:00:00Z');
    const { phase } = setup(makeEvent());
    expect(await phase.isTestModeNow(makeEvent())).toBe(true);
    expect(
      await phase.isTestModeNow(makeEvent({ status: EventStatus.TEST })),
    ).toBe(true);
    now('2026-11-16T12:00:00Z');
    expect(await phase.isTestModeNow(makeEvent())).toBe(false);
  });

  it('decorate adds phase, realSalesFrom/Until and presaleEnabled', async () => {
    now('2026-11-08T12:00:00Z');
    const { phase } = setup(makeEvent());
    const decorated = await phase.decorate(makeEvent());
    expect(decorated).toMatchObject({
      phase: 'planned',
      realSalesFrom: '2026-11-15T17:00:00.000Z',
      realSalesUntil: '2026-11-18T11:00:00.000Z',
      presaleEnabled: false,
    });
    expect(decorated.phaseDetails).toMatchObject({
      earlyStartHours: 12,
      graceHours: 6,
      datesLocked: false,
    });
  });
});
