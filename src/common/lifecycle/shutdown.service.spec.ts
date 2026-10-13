import { ShutdownService } from './shutdown.service';

describe('ShutdownService', () => {
  const env = { ...process.env };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...env };
  });

  function setup() {
    const server = { closeAllConnections: jest.fn() };
    const host = { httpAdapter: { getHttpServer: () => server } };
    return { server, service: new ShutdownService(host as never) };
  }

  it('is not draining while running', () => {
    expect(setup().service.isDraining).toBe(false);
  });

  it('starts draining on shutdown', async () => {
    const { service } = setup();
    await service.beforeApplicationShutdown('SIGTERM');
    expect(service.isDraining).toBe(true);
  });

  it('cuts open connections after 20 s, not before', async () => {
    const { server, service } = setup();
    await service.beforeApplicationShutdown('SIGTERM');

    jest.advanceTimersByTime(19_999);
    expect(server.closeAllConnections).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  it('honours SHUTDOWN_TIMEOUT_MS', async () => {
    process.env.SHUTDOWN_TIMEOUT_MS = '5000';
    const { server, service } = setup();
    await service.beforeApplicationShutdown('SIGTERM');

    jest.advanceTimersByTime(5000);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  it('keeps serving for SHUTDOWN_DRAIN_DELAY_MS before closing', async () => {
    process.env.SHUTDOWN_DRAIN_DELAY_MS = '3000';
    const { service } = setup();
    let done = false;
    const pending = service
      .beforeApplicationShutdown('SIGTERM')
      .then(() => (done = true));

    expect(service.isDraining).toBe(true);
    await jest.advanceTimersByTimeAsync(2999);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });
});
