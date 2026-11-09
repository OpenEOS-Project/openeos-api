import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FindManyOptions, Repository } from 'typeorm';

import { validationSchema } from '../../config/validation.schema';
import type { DeploymentService } from '../../common/services/deployment.service';
import { Event, EventStatus } from '../../database/entities/event.entity';
import type { Device, Organization, User } from '../../database/entities';
import { EmailService } from '../email/email.service';
import { EventPhaseService } from '../events/event-phase.service';
import { DeviceEmergencySupportController } from './device-emergency-support.controller';
import {
  emergencyPhoneTelUri,
  isEmergencySupportEvent,
  normalizeEmergencyPhone,
} from './emergency-support';
import { EmergencySupportService } from './emergency-support.service';
import { SupportController } from './support.controller';
import type { SupportService } from './support.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const PHONE = '+49 15678 142392';
const ORG = '11111111-1111-4111-8111-111111111111';

/** Fest 16.–17.11.2026 (Berlin): echt ab 15.11. 18:00 bis 18.11. 12:00. */
const NOW_PLANNED = new Date('2026-11-10T12:00:00Z');
const NOW_ACTIVE = new Date('2026-11-16T20:00:00Z');
const NOW_GRACE = new Date('2026-11-18T10:30:00Z');
const NOW_ENDED = new Date('2026-11-18T11:00:00Z');

function event(overrides: Partial<Event> = {}): Event {
  return {
    id: 'e1',
    organizationId: ORG,
    status: EventStatus.ACTIVE,
    billingStatus: 'paid',
    startDate: new Date('2026-11-16T00:00:00+01:00'),
    endDate: new Date('2026-11-17T00:00:00+01:00'),
    settings: {},
    ...overrides,
  } as Event;
}

function setup(options: {
  phone?: string;
  events?: Event[];
  billingEnabled?: boolean;
}) {
  const find = jest
    .fn<Promise<Event[]>, [FindManyOptions<Event>]>()
    .mockResolvedValue(options.events ?? []);
  const eventRepository = { find } as unknown as Repository<Event>;
  const deployment = {
    billingEnabled: options.billingEnabled ?? true,
  } as DeploymentService;
  const phase = EventPhaseService.standalone(
    {
      findOne: () => Promise.resolve({ id: ORG, settings: {}, country: 'DE' }),
    } as unknown as Repository<Organization>,
    null,
    null,
    deployment,
  );
  const config = {
    get: (key: string) =>
      key === 'OPERATOR_EMERGENCY_PHONE' ? options.phone : undefined,
  } as unknown as ConfigService;
  const service = new EmergencySupportService(
    config,
    deployment,
    phase,
    eventRepository,
  );
  return { service, find };
}

describe('emergency support helpers', () => {
  it('normalizes the configured number', () => {
    expect(normalizeEmergencyPhone(undefined)).toBeNull();
    expect(normalizeEmergencyPhone('')).toBeNull();
    expect(normalizeEmergencyPhone('   ')).toBeNull();
    expect(normalizeEmergencyPhone('  +49  15678 142392 ')).toBe(PHONE);
  });

  it('builds a tel: URI with only + and digits', () => {
    expect(emergencyPhoneTelUri(PHONE)).toBe('tel:+4915678142392');
    expect(emergencyPhoneTelUri('+49 (0) 30/123-45')).toBe('tel:+4903012345');
  });

  it('accepts a phone number or empty in the config schema', () => {
    const validate = (value: string) =>
      validationSchema.validate(
        { JWT_SECRET: 'x', OPERATOR_EMERGENCY_PHONE: value },
        { allowUnknown: true },
      ).error;
    expect(validate(PHONE)).toBeUndefined();
    expect(validate('')).toBeUndefined();
    expect(validate('ruf mich an')).toBeDefined();
    expect(validate('<script>')).toBeDefined();
  });
});

describe('isEmergencySupportEvent', () => {
  const until = { realSalesUntil: '2026-11-18T11:00:00.000Z' };
  const hosted = { billingEnabled: true };

  it('needs a booked event (paid, invoice, waived) when billing is on', () => {
    for (const billingStatus of ['paid', 'invoice', 'waived'] as const) {
      expect(
        isEmergencySupportEvent(
          { status: 'active', billingStatus },
          until,
          hosted,
          NOW_ACTIVE,
        ),
      ).toBe(true);
    }
    for (const billingStatus of ['none', 'pending', null] as const) {
      expect(
        isEmergencySupportEvent(
          { status: 'active', billingStatus },
          { realSalesUntil: null },
          hosted,
          NOW_ACTIVE,
        ),
      ).toBe(false);
    }
  });

  it('never counts the test mode', () => {
    expect(
      isEmergencySupportEvent(
        { status: 'test', billingStatus: 'paid' },
        until,
        hosted,
        NOW_ACTIVE,
      ),
    ).toBe(false);
  });

  it('ends with the sales window (after the grace hours)', () => {
    const booked = {
      status: 'active' as const,
      billingStatus: 'paid' as const,
    };
    expect(isEmergencySupportEvent(booked, until, hosted, NOW_GRACE)).toBe(
      true,
    );
    expect(isEmergencySupportEvent(booked, until, hosted, NOW_ENDED)).toBe(
      false,
    );
  });

  it('without a sales window only while the event is switched on', () => {
    const none = { realSalesUntil: null };
    expect(
      isEmergencySupportEvent(
        { status: 'active', billingStatus: 'waived' },
        none,
        hosted,
      ),
    ).toBe(true);
    expect(
      isEmergencySupportEvent(
        { status: 'inactive', billingStatus: 'waived' },
        none,
        hosted,
      ),
    ).toBe(false);
  });

  it('self-hosted (no billing): active and not ended', () => {
    const selfHosted = { billingEnabled: false };
    expect(
      isEmergencySupportEvent(
        { status: 'active', billingStatus: 'none' },
        until,
        selfHosted,
        NOW_ACTIVE,
      ),
    ).toBe(true);
    expect(
      isEmergencySupportEvent(
        { status: 'inactive', billingStatus: 'none' },
        until,
        selfHosted,
        NOW_ACTIVE,
      ),
    ).toBe(false);
    expect(
      isEmergencySupportEvent(
        { status: 'active', billingStatus: 'none' },
        until,
        selfHosted,
        NOW_ENDED,
      ),
    ).toBe(false);
  });
});

describe('EmergencySupportService.forOrganization', () => {
  it('shows nothing without OPERATOR_EMERGENCY_PHONE (no DB query)', async () => {
    const { service, find } = setup({ phone: '', events: [event()] });
    await expect(service.forOrganization(ORG, NOW_ACTIVE)).resolves.toEqual({
      phone: null,
      telUri: null,
      eventIds: [],
    });
    expect(find).not.toHaveBeenCalled();
  });

  it('shows the number in the planned and active phase', async () => {
    const { service } = setup({ phone: PHONE, events: [event()] });
    for (const now of [NOW_PLANNED, NOW_ACTIVE, NOW_GRACE]) {
      await expect(service.forOrganization(ORG, now)).resolves.toEqual({
        phone: PHONE,
        telUri: 'tel:+4915678142392',
        eventIds: ['e1'],
      });
    }
  });

  it('hides the number once every booked event has ended', async () => {
    const { service } = setup({ phone: PHONE, events: [event()] });
    await expect(service.forOrganization(ORG, NOW_ENDED)).resolves.toEqual({
      phone: null,
      telUri: null,
      eventIds: [],
    });
  });

  it('hides the number without any booked event', async () => {
    const { service } = setup({ phone: PHONE, events: [] });
    await expect(
      service.forOrganization(ORG, NOW_ACTIVE),
    ).resolves.toMatchObject({ phone: null });
  });

  it('lists only the events that still qualify', async () => {
    const { service } = setup({
      phone: PHONE,
      events: [
        event({
          id: 'old',
          startDate: new Date('2026-10-01T10:00:00Z'),
          endDate: new Date('2026-10-01T10:00:00Z'),
        }),
        event({ id: 'next' }),
      ],
    });
    await expect(service.forOrganization(ORG, NOW_ACTIVE)).resolves.toEqual(
      expect.objectContaining({ eventIds: ['next'] }),
    );
  });

  it('queries only booked, non-test events of the organization (hosted)', async () => {
    const { service, find } = setup({ phone: PHONE, events: [] });
    await service.forOrganization(ORG, NOW_ACTIVE);
    expect(find.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      status: { _type: 'not', _value: 'test' },
      billingStatus: { _type: 'in', _value: ['paid', 'invoice', 'waived'] },
    });
  });

  it('self-hosted with a configured number: active events only', async () => {
    const { service, find } = setup({
      phone: PHONE,
      billingEnabled: false,
      events: [event({ billingStatus: 'none' })],
    });
    await expect(service.forOrganization(ORG, NOW_ACTIVE)).resolves.toEqual(
      expect.objectContaining({ phone: PHONE, eventIds: ['e1'] }),
    );
    expect(find.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      status: EventStatus.ACTIVE,
    });
  });
});

describe('who may ask', () => {
  const info = { phone: PHONE, telUri: 'tel:+4915678142392', eventIds: ['e1'] };

  it('members only: the membership check runs first', async () => {
    const checkMembership = jest
      .fn()
      .mockRejectedValue(new ForbiddenException('Kein Zugriff'));
    const forOrganization = jest.fn().mockResolvedValue(info);
    const controller = new SupportController(
      { checkMembership } as unknown as SupportService,
      { forOrganization } as unknown as EmergencySupportService,
    );

    await expect(
      controller.getEmergency(ORG, { id: 'u1' } as User),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(forOrganization).not.toHaveBeenCalled();
  });

  it('members get the number of their organization', async () => {
    const checkMembership = jest.fn().mockResolvedValue({});
    const forOrganization = jest.fn().mockResolvedValue(info);
    const controller = new SupportController(
      { checkMembership } as unknown as SupportService,
      { forOrganization } as unknown as EmergencySupportService,
    );

    await expect(
      controller.getEmergency(ORG, { id: 'u1' } as User),
    ).resolves.toEqual({ data: info });
    expect(checkMembership).toHaveBeenCalledWith(ORG, 'u1');
    expect(forOrganization).toHaveBeenCalledWith(ORG);
  });

  it('devices get the number of the organization they belong to', async () => {
    const forOrganization = jest.fn().mockResolvedValue(info);
    const controller = new DeviceEmergencySupportController({
      forOrganization,
    } as unknown as EmergencySupportService);

    await expect(
      controller.emergency({ id: 'd1', organizationId: ORG } as Device),
    ).resolves.toEqual({ data: info });
    expect(forOrganization).toHaveBeenCalledWith(ORG);
  });
});

describe('booking confirmation mail', () => {
  function send(emergencyPhone: { phone: string; telUri: string } | null) {
    const service = new EmailService({
      get: () => undefined,
    } as unknown as ConfigService);
    const sendEmail = jest.spyOn(service, 'sendEmail').mockResolvedValue(true);
    return service
      .sendEventBookingConfirmationEmail({
        to: 'a@b.de',
        organizationName: 'TSV',
        eventName: 'Sommerfest',
        startDate: new Date('2026-11-16T10:00:00Z'),
        endDate: new Date('2026-11-17T10:00:00Z'),
        timeZone: 'Europe/Berlin',
        days: 2,
        tseIncluded: false,
        amount: 50,
        currency: 'EUR',
        paymentMethod: 'stripe',
        invoiceNumber: null,
        bookedAt: new Date('2026-11-09T10:00:00Z'),
        documents: [],
        elster: null,
        emergencyPhone,
      })
      .then(() => sendEmail.mock.calls[0][0].html);
  }

  it('names the emergency number with a tel: link when configured', async () => {
    const html = await send({ phone: PHONE, telUri: 'tel:+4915678142392' });
    expect(html).toContain('Notfall-Support am Veranstaltungstag');
    expect(html).toContain('href="tel:+4915678142392"');
    expect(html).toContain(PHONE);
  });

  it('leaves it out without a number', async () => {
    const html = await send(null);
    expect(html).not.toContain('Notfall-Support');
    expect(html).not.toContain('tel:');
  });
});
