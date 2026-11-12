import { ThrottlerStorageService } from '@nestjs/throttler';

import { ContactService } from './contact.service';
import { TargetLimitService } from '../../common/rate-limit/target-limit.service';

describe('Contact form notifications', () => {
  function setup() {
    const storage = new ThrottlerStorageService();
    const repo = {
      create: jest.fn((v: unknown) => v),
      save: jest.fn((v: object) => Promise.resolve({ id: 'c1', ...v })),
      update: jest.fn(() => Promise.resolve({})),
    };
    const email = {
      sendAdminContactRequestNotification: jest.fn(() => Promise.resolve()),
    };
    const settings = {
      resolveNotificationTarget: jest.fn(() =>
        Promise.resolve('team@example.org'),
      ),
    };
    const service = new ContactService(
      repo as never,
      email as never,
      settings as never,
      new TargetLimitService(storage),
    );
    return { service, repo, email, storage };
  }

  const dto = (email: string) => ({
    type: 'demo',
    name: 'Nina',
    email,
    message: 'Hallo',
    startedAt: Date.now() - 60_000,
  });

  it('stores every request but notifies at most three times per sender and hour', async () => {
    const { service, repo, email, storage } = setup();
    for (let i = 0; i < 5; i += 1) {
      await expect(
        service.submit(dto('nina@example.org') as never),
      ).resolves.toHaveProperty('message');
    }
    await service.submit(dto('other@example.org') as never);
    storage.onApplicationShutdown();

    expect(repo.save).toHaveBeenCalledTimes(6);
    expect(email.sendAdminContactRequestNotification).toHaveBeenCalledTimes(4);
  });
});
