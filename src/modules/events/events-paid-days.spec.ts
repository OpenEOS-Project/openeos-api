import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { EventsService } from './events.service';
import { Event } from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import { DeploymentService } from '../../common/services/deployment.service';
import { GatewayService } from '../gateway/gateway.service';
import { TestOrderCleanupService } from './test-order-cleanup.service';

/**
 * Eine bezahlte Veranstaltung darf nicht laenger werden als bezahlt —
 * gezaehlt nach Geschaeftstagen, gemessen an den beim Freischalten
 * festgehaltenen Tagen.
 */
describe('EventsService – bezahlte Dauer', () => {
  function setup(event: Partial<Event>) {
    const organizationRepository = {
      findOne: jest
        .fn()
        .mockResolvedValue({ settings: { timezone: 'Europe/Berlin' } }),
    } as unknown as Repository<Organization>;
    const unused = {} as never;
    const service = new EventsService(
      unused,
      organizationRepository,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused as unknown as GatewayService,
      { billingEnabled: true } as unknown as DeploymentService,
      unused as unknown as TestOrderCleanupService,
      { get: () => undefined } as unknown as ConfigService,
    );
    const check = (start: string, end: string) =>
      (
        service as unknown as {
          assertPaidDurationNotExtended: (
            e: Event,
            s: Date,
            n: Date,
          ) => Promise<void>;
        }
      ).assertPaidDurationNotExtended(
        {
          organizationId: 'org-1',
          billingStatus: 'paid',
          billedDays: null,
          ...event,
        } as Event,
        new Date(start),
        new Date(end),
      );
    return { check };
  }

  it('ein bezahlter Tag laesst sich bis 6 Uhr morgens verlaengern', async () => {
    const { check } = setup({
      startDate: new Date('2026-10-17T20:00+02:00'),
      endDate: new Date('2026-10-17T23:00+02:00'),
      billedDays: 1,
    });
    await expect(
      check('2026-10-17T20:00+02:00', '2026-10-18T06:00+02:00'),
    ).resolves.toBeUndefined();
    await expect(
      check('2026-10-17T20:00+02:00', '2026-10-18T12:00+02:00'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('nach Kalendertagen bezahlte Tage bleiben nutzbar', async () => {
    // Bezahlt als zwei Kalendertage, nach neuer Regel nur einer.
    const { check } = setup({
      startDate: new Date('2026-10-17T20:00+02:00'),
      endDate: new Date('2026-10-18T02:00+02:00'),
      billedDays: 2,
    });
    await expect(
      check('2026-10-17T20:00+02:00', '2026-10-18T18:00+02:00'),
    ).resolves.toBeUndefined();
  });

  it('eine unveraenderte Veranstaltung wird nie als verlaengert abgelehnt', async () => {
    // Nach Kalendertagen ein Tag bezahlt, nach Geschaeftstagen zwei.
    const { check } = setup({
      startDate: new Date('2026-10-17T03:00+02:00'),
      endDate: new Date('2026-10-17T23:00+02:00'),
      billedDays: 1,
    });
    await expect(
      check('2026-10-17T03:00+02:00', '2026-10-17T23:00+02:00'),
    ).resolves.toBeUndefined();
  });

  it('ohne festgehaltene Tage zaehlt der bisherige Zeitraum', async () => {
    const { check } = setup({
      startDate: new Date('2026-10-16T00:00+02:00'),
      endDate: new Date('2026-10-18T00:00+02:00'),
    });
    await expect(
      check('2026-10-16T00:00+02:00', '2026-10-18T00:00+02:00'),
    ).resolves.toBeUndefined();
    await expect(
      check('2026-10-16T00:00+02:00', '2026-10-19T00:00+02:00'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
