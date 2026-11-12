import { HttpException } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';

import { ShiftsService } from './shifts.service';
import { TargetLimitService } from '../../common/rate-limit/target-limit.service';

/**
 * Helfer-Mails (Anmeldebestaetigung, Link zum Verwalten) gehen je Adresse
 * nur begrenzt oft raus.
 */
describe('Shift mail limits per address', () => {
  let storage: ThrottlerStorageService;
  beforeEach(() => {
    storage = new ThrottlerStorageService();
  });
  afterEach(() => storage.onApplicationShutdown());

  function setup() {
    const qb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({
        email: 'helfer@example.org',
        name: 'Helfer',
      }),
    };
    const planRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'plan-1',
        name: 'Fest',
        status: 'published',
        settings: {},
      }),
    };
    const shiftRepo = { find: jest.fn().mockResolvedValue([]) };
    const registrationRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
    const magicLinkRepo = {
      create: jest.fn((v: unknown) => v),
      save: jest.fn((v: unknown) => Promise.resolve(v)),
    };
    const email = {
      appUrl: 'https://app.example.org',
      sendHelperMagicLinkEmail: jest.fn().mockResolvedValue(undefined),
    };
    const none = {} as never;
    const service = new ShiftsService(
      planRepo as never,
      none,
      shiftRepo as never,
      registrationRepo as never,
      none,
      magicLinkRepo as never,
      email as never,
      new TargetLimitService(storage),
    );
    return { service, email, shiftRepo };
  }

  it('sends at most five manage links per hour to one address', async () => {
    const { service, email } = setup();
    for (let i = 0; i < 7; i++) {
      await service.requestHelperMagicLink('fest', 'Helfer@example.org');
    }
    expect(email.sendHelperMagicLinkEmail).toHaveBeenCalledTimes(5);
  });

  it('answers sign-ups beyond the per-address limit with 429', async () => {
    const { service, shiftRepo } = setup();
    jest
      .spyOn(service as never, 'findPlanBySlug' as never)
      .mockResolvedValue({ id: 'plan-1', settings: {} } as never);
    for (let i = 0; i < 10; i++) {
      // Bis zur Grenze laeuft die Anmeldung weiter (hier: Schicht fehlt).
      const status = await service
        .publicRegister('fest', 'A', 'a@example.org', ['s1'])
        .catch((e: HttpException) => e.getStatus());
      expect(status).toBe(400);
    }
    const error: unknown = await service
      .publicRegister('fest', 'A', 'a@example.org', ['s1'])
      .catch((e: unknown) => e);
    expect((error as HttpException).getStatus()).toBe(429);
    expect(shiftRepo.find).toHaveBeenCalledTimes(10);
  });
});
