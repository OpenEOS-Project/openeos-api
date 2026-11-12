import { ThrottlerStorageService } from '@nestjs/throttler';

import { TargetLimitService } from './target-limit.service';

describe('TargetLimitService', () => {
  let storage: ThrottlerStorageService;
  beforeEach(() => {
    storage = new ThrottlerStorageService();
  });
  afterEach(() => storage.onApplicationShutdown());

  it('allows up to the limit per target, then refuses', async () => {
    const limits = new TargetLimitService(storage);
    const limit = { limit: 2, windowMs: 60_000 };

    expect(await limits.allow('reset', 'a@example.org', limit)).toBe(true);
    expect(await limits.allow('reset', 'A@Example.org ', limit)).toBe(true);
    expect(await limits.allow('reset', 'a@example.org', limit)).toBe(false);
  });

  it('counts targets and scopes separately', async () => {
    const limits = new TargetLimitService(storage);
    const limit = { limit: 1, windowMs: 60_000 };

    expect(await limits.allow('reset', 'a@example.org', limit)).toBe(true);
    expect(await limits.allow('reset', 'b@example.org', limit)).toBe(true);
    expect(await limits.allow('magic', 'a@example.org', limit)).toBe(true);
    expect(await limits.allow('reset', 'a@example.org', limit)).toBe(false);
  });

  it('keeps addresses out of the stored keys', async () => {
    const increment = jest.spyOn(storage, 'increment');
    await new TargetLimitService(storage).allow('reset', 'a@example.org', {
      limit: 1,
      windowMs: 60_000,
    });
    const [key] = increment.mock.calls[0];
    expect(key).toMatch(/^reset:[0-9a-f]{32}$/);
  });

  it('allows everything without a storage', async () => {
    const limits = new TargetLimitService();
    expect(
      await limits.allow('reset', 'a@example.org', { limit: 0, windowMs: 1 }),
    ).toBe(true);
  });
});
