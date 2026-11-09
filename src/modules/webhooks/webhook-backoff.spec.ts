import { loadWebhooksConfig } from './webhooks.config';
import {
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_RETRY_JITTER,
  nextRetryAt,
} from './webhook-backoff';

describe('webhook backoff', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const fixed = () => 0.5; // Faktor 1, ohne Streuung

  it('8 attempts: now, +1 min, +5 min, +30 min, +2 h, +5 h, +8 h, +8 h (~24 h)', () => {
    const delays: number[] = [];
    for (let attempts = 1; attempts < 8; attempts += 1) {
      const at = nextRetryAt(attempts, 8, now, fixed);
      expect(at).not.toBeNull();
      delays.push(at!.getTime() - now.getTime());
    }
    expect(delays).toEqual([...WEBHOOK_RETRY_DELAYS_MS]);
    const total = delays.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(23 * 3_600_000);
    expect(total).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it('stops after maxAttempts', () => {
    expect(nextRetryAt(8, 8, now, fixed)).toBeNull();
    expect(nextRetryAt(1, 1, now, fixed)).toBeNull();
    expect(nextRetryAt(3, 3, now, fixed)).toBeNull();
  });

  it('adds at most ±10 % jitter', () => {
    const low = nextRetryAt(1, 8, now, () => 0)!.getTime() - now.getTime();
    const high =
      nextRetryAt(1, 8, now, () => 0.999999)!.getTime() - now.getTime();
    expect(low).toBe(Math.round(60_000 * (1 - WEBHOOK_RETRY_JITTER)));
    expect(high).toBeLessThanOrEqual(
      Math.round(60_000 * (1 + WEBHOOK_RETRY_JITTER)),
    );
    expect(high).toBeGreaterThan(60_000);
  });
});

describe('webhooks config', () => {
  it('has the documented defaults', () => {
    expect(loadWebhooksConfig({})).toEqual({
      enabled: true,
      timeoutMs: 10_000,
      maxAttempts: 8,
      maxEndpointsPerOrganization: 10,
      disableAfterFailures: 30,
      disableAfterHours: 24,
      deliveryRetentionDays: 30,
      pollIntervalMs: 3_000,
      concurrency: 10,
      allowHttp: false,
      allowPrivateNetworks: false,
    });
  });

  it('reads and clamps the environment', () => {
    const config = loadWebhooksConfig({
      WEBHOOKS_ENABLED: 'false',
      WEBHOOKS_TIMEOUT_MS: '999999',
      WEBHOOKS_MAX_ATTEMPTS: '20',
      WEBHOOKS_MAX_ENDPOINTS_PER_ORG: '3',
      WEBHOOKS_ALLOW_HTTP: 'true',
      WEBHOOKS_ALLOW_PRIVATE_NETWORKS: '1',
      WEBHOOKS_POLL_INTERVAL_MS: 'abc',
    });
    expect(config.enabled).toBe(false);
    expect(config.timeoutMs).toBe(30_000);
    expect(config.maxAttempts).toBe(8);
    expect(config.maxEndpointsPerOrganization).toBe(3);
    expect(config.allowHttp).toBe(true);
    expect(config.allowPrivateNetworks).toBe(true);
    expect(config.pollIntervalMs).toBe(3_000);
  });
});
