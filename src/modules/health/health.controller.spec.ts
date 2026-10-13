import { HealthController } from './health.controller';

describe('HealthController readiness', () => {
  function setup(
    overrides: {
      query?: jest.Mock;
      ping?: jest.Mock;
      showMigrations?: jest.Mock;
      draining?: boolean;
    } = {},
  ) {
    const dataSource = {
      query:
        overrides.query ?? jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      showMigrations:
        overrides.showMigrations ?? jest.fn().mockResolvedValue(false),
    };
    const redis = {
      ping: overrides.ping ?? jest.fn().mockResolvedValue('PONG'),
    };
    const shutdown = { isDraining: overrides.draining ?? false };
    const res = { status: jest.fn() };
    const controller = new HealthController(
      dataSource as never,
      redis as never,
      shutdown as never,
    );
    return { controller, res, dataSource };
  }

  it('is ready when database, Redis and schema are fine', async () => {
    const { controller, res } = setup();
    const result = await controller.readiness(res as never);

    expect(result.status).toBe('ok');
    expect(res.status).not.toHaveBeenCalled();
    expect(Object.keys(result.checks!)).toEqual([
      'database',
      'redis',
      'migrations',
    ]);
  });

  it('answers 503 when Redis is unreachable', async () => {
    const { controller, res } = setup({
      ping: jest.fn().mockRejectedValue(new Error('The client is closed')),
    });
    const result = await controller.readiness(res as never);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(result.checks!.redis).toEqual({
      status: 'error',
      message: 'The client is closed',
    });
  });

  it('answers 503 when the database fails', async () => {
    const { controller, res } = setup({
      query: jest.fn().mockRejectedValue(new Error('connection refused')),
    });
    await controller.readiness(res as never);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('answers 503 while migrations are pending', async () => {
    const { controller, res } = setup({
      showMigrations: jest.fn().mockResolvedValue(true),
    });
    const result = await controller.readiness(res as never);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(result.checks!.migrations.status).toBe('error');
  });

  it('checks migrations only until they are applied', async () => {
    const { controller, res, dataSource } = setup();
    await controller.readiness(res as never);
    await controller.readiness(res as never);
    expect(dataSource.showMigrations).toHaveBeenCalledTimes(1);
  });

  it('answers 503 while shutting down', async () => {
    const { controller, res } = setup({ draining: true });
    const result = await controller.readiness(res as never);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(result.checks!.shutdown.status).toBe('error');
  });

  it('counts a hanging check as failed', async () => {
    jest.useFakeTimers();
    try {
      const { controller, res } = setup({
        ping: jest.fn(() => new Promise(() => undefined)),
      });
      const pending = controller.readiness(res as never);
      await jest.advanceTimersByTimeAsync(2000);
      const result = await pending;

      expect(res.status).toHaveBeenCalledWith(503);
      expect(result.checks!.redis.message).toMatch(/did not answer/);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('HealthController rate limiting', () => {
  // Metadaten haengen am Handler; nur gelesen, nie aufgerufen.
  const skipped = (name: keyof HealthController) =>
    Reflect.getMetadata(
      'THROTTLER:SKIPdefault',
      Object.getOwnPropertyDescriptor(HealthController.prototype, name)!
        .value as object,
    ) === true;

  it('does not rate-limit the liveness checks', () => {
    expect(skipped('check')).toBe(true);
    expect(skipped('liveness')).toBe(true);
  });

  it('keeps the rate limit on checks that touch database and Redis', () => {
    expect(skipped('readiness')).toBe(false);
    expect(skipped('detailed')).toBe(false);
  });
});
