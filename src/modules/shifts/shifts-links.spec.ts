import { ShiftsService } from './shifts.service';
import { ShiftsPublicController } from './shifts-public.controller';

/**
 * Links in Helfer-Mails kommen immer aus der konfigurierten App-URL.
 */
describe('Helper links in shift mails', () => {
  function serviceWith(appUrl: string) {
    const registration = {
      email: 'helfer@example.org',
      name: 'Helfer',
      status: 'confirmed',
    };
    const qb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(registration),
    };
    const planRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'plan-1', name: 'Fest' }),
    };
    const registrationRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
    const magicLinkRepo = {
      create: jest.fn((v: unknown) => v),
      save: jest.fn((v: unknown) => Promise.resolve(v)),
    };
    const email = {
      appUrl,
      sendHelperMagicLinkEmail: jest.fn().mockResolvedValue(undefined),
    };
    const none = {} as never;
    const service = new ShiftsService(
      planRepo as never,
      none,
      none,
      registrationRepo as never,
      none,
      magicLinkRepo as never,
      email as never,
    );
    return { service, email };
  }

  it('builds the manage link from the configured app URL', async () => {
    const { service, email } = serviceWith('https://app.example.org/');
    await service.requestHelperMagicLink('fest', 'helfer@example.org');

    const [[, , , url]] = email.sendHelperMagicLinkEmail.mock
      .calls as unknown as [[string, string, string, string]];
    expect(url).toMatch(
      /^https:\/\/app\.example\.org\/s\/manage\/[0-9a-z]{64}$/,
    );
  });

  it('passes no request-derived base URL from the public controller', async () => {
    const shifts = {
      publicRegister: jest
        .fn()
        .mockResolvedValue({ registrationGroupId: 'g', shiftsCount: 1 }),
      requestHelperMagicLink: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new ShiftsPublicController(shifts as never, {} as never);

    await controller.register('fest', {
      name: 'A',
      email: 'a@example.org',
      shiftIds: ['s1'],
    } as never);
    await controller.requestMagicLink('fest', { email: 'a@example.org' });

    expect(shifts.publicRegister.mock.calls[0]).toHaveLength(6);
    expect(shifts.requestHelperMagicLink).toHaveBeenCalledWith(
      'fest',
      'a@example.org',
    );
  });
});
