import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { REDIS_CLIENT } from '../../common/redis/redis.constants';
import type { RedisClient } from '../../common/redis/redis.constants';
import { Device } from '../../database/entities/device.entity';

/**
 * Sperre nach Fehlversuchen bei der PIN-Eingabe (bedienungen-plan.md §11):
 *
 * - je Geraet: 5 Fehlversuche → 30 s, 10 → 5 min, 20 → PIN-Eingabe
 *   gesperrt, bis ein Admin sie freigibt (`settings.waiterPinLockedAt`).
 *   Ein Treffer setzt den Zaehler zurueck.
 * - je Organisation: mehr als 50 Fehlversuche in 10 min → alle
 *   PIN-Eingaben der Organisation 60 s gesperrt.
 *
 * Zaehler liegen in Redis (alle API-Instanzen); faellt Redis aus, zaehlt
 * die Instanz im Speicher weiter. Die Admin-Sperre steht in der Datenbank.
 */
export const LOCK_STEPS = [
  { failures: 20, seconds: null },
  { failures: 10, seconds: 300 },
  { failures: 5, seconds: 30 },
] as const;
export const ORG_FAILURE_LIMIT = 50;
export const ORG_WINDOW_SECONDS = 600;
export const ORG_LOCK_SECONDS = 60;
const DEVICE_COUNTER_TTL = 3600;

export interface FailureOutcome {
  failures: number;
  /** Versuche bis zur naechsten Sperrstufe. */
  remainingAttempts: number;
  /** Gerade gesperrt fuer so viele Sekunden (null = bis zur Freigabe). */
  lockedForSeconds: number | null | undefined;
}

export function remainingAttempts(failures: number): number {
  const next = [...LOCK_STEPS]
    .map((s) => s.failures)
    .sort((a, b) => a - b)
    .find((limit) => limit > failures);
  return next === undefined ? 0 : next - failures;
}

export function lockFor(failures: number): number | null | undefined {
  for (const step of LOCK_STEPS) {
    if (failures >= step.failures) return step.seconds;
  }
  return undefined;
}

export function pinLockedError(retryAfterSeconds: number): HttpException {
  return new HttpException(
    {
      code: ErrorCodes.TOO_MANY_ATTEMPTS,
      reason: ErrorReasons.PIN_LOCKED,
      message: `Zu viele falsche PINs. Versuche es in ${retryAfterSeconds} Sekunden noch einmal.`,
      params: { retryAfterSeconds },
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

export function deviceLockedError(): HttpException {
  return new HttpException(
    {
      code: ErrorCodes.TOO_MANY_ATTEMPTS,
      reason: ErrorReasons.PIN_DEVICE_LOCKED,
      message:
        'Die PIN-Eingabe an diesem Gerät ist nach zu vielen Fehlversuchen gesperrt. Ein Admin gibt sie in der Verwaltung unter Geräte wieder frei.',
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

@Injectable()
export class PinLockoutService {
  private readonly logger = new Logger(PinLockoutService.name);
  /** Rueckfall ohne Redis: Schluessel → { Wert, Ablauf }. */
  private readonly memory = new Map<
    string,
    { value: number; expires: number }
  >();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** 429, solange Geraet oder Organisation gesperrt sind. */
  async assertNotLocked(
    device: Pick<Device, 'id' | 'organizationId' | 'settings'>,
  ): Promise<void> {
    if (device.settings?.waiterPinLockedAt) throw deviceLockedError();
    const ttl = Math.max(
      await this.ttl(`waiter-pin:lock:${device.id}`),
      device.organizationId
        ? await this.ttl(`waiter-pin:orglock:${device.organizationId}`)
        : 0,
    );
    if (ttl > 0) throw pinLockedError(ttl);
  }

  async recordFailure(
    device: Pick<Device, 'id' | 'organizationId' | 'name'>,
  ): Promise<FailureOutcome> {
    const failures = await this.incr(
      `waiter-pin:fail:${device.id}`,
      DEVICE_COUNTER_TTL,
    );
    if (device.organizationId) {
      const orgFailures = await this.incr(
        `waiter-pin:orgfail:${device.organizationId}`,
        ORG_WINDOW_SECONDS,
      );
      if (orgFailures > ORG_FAILURE_LIMIT) {
        await this.set(
          `waiter-pin:orglock:${device.organizationId}`,
          ORG_LOCK_SECONDS,
        );
        this.logger.warn(
          `PIN entry of organization ${device.organizationId} paused: ${orgFailures} failures in ${ORG_WINDOW_SECONDS / 60} min`,
        );
      }
    }
    const lock = lockFor(failures);
    if (lock === null) {
      await this.lockDevice(device);
      await this.del(`waiter-pin:fail:${device.id}`);
    } else if (lock !== undefined) {
      await this.set(`waiter-pin:lock:${device.id}`, lock);
      this.logger.warn(
        `PIN entry on device ${device.id} locked for ${lock}s after ${failures} failures`,
      );
    }
    return {
      failures,
      remainingAttempts: remainingAttempts(failures),
      lockedForSeconds: lock,
    };
  }

  async recordSuccess(device: Pick<Device, 'id'>): Promise<void> {
    await this.del(`waiter-pin:fail:${device.id}`);
  }

  /** Stufe 3: PIN-Eingabe bis zur Freigabe durch einen Admin sperren. */
  private async lockDevice(
    device: Pick<Device, 'id' | 'organizationId' | 'name'>,
  ): Promise<void> {
    const lockedAt = new Date().toISOString();
    await this.dataSource.query(
      `UPDATE devices
          SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('waiterPinLockedAt', $2::text),
              updated_at = now()
        WHERE id = $1`,
      [device.id, lockedAt],
    );
    // Offene Sitzungen an diesem Geraet enden.
    await this.dataSource.query(
      `UPDATE waiter_sessions SET ended_at = now(), end_reason = 'device_blocked', updated_at = now()
        WHERE device_id = $1 AND ended_at IS NULL`,
      [device.id],
    );
    await this.dataSource
      .query(
        `INSERT INTO admin_audit_logs (admin_user_id, organization_id, action, resource_type, resource_id, details, ip_address)
         VALUES (NULL, $1, 'waiter_pin_lock', 'device', $2, $3::jsonb, 'system')`,
        [
          device.organizationId,
          device.id,
          JSON.stringify({ deviceName: device.name, lockedAt }),
        ],
      )
      .catch((error: Error) =>
        this.logger.error(`Audit of PIN lock not written: ${error.message}`),
      );
    this.logger.warn(
      `PIN entry on device ${device.id} locked until released by an admin`,
    );
  }

  // ---------------------------------------------------------- Speicher

  private async incr(key: string, ttlSeconds: number): Promise<number> {
    try {
      const value = await this.redis.incr(key);
      if (value === 1) await this.redis.expire(key, ttlSeconds);
      return value;
    } catch (error) {
      this.logger.warn(
        `PIN lockout without Redis: ${(error as Error).message}`,
      );
      const now = Date.now();
      const entry = this.memory.get(key);
      const value = entry && entry.expires > now ? entry.value + 1 : 1;
      this.memory.set(key, {
        value,
        expires:
          entry && entry.expires > now
            ? entry.expires
            : now + ttlSeconds * 1000,
      });
      return value;
    }
  }

  private async set(key: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, '1', { EX: ttlSeconds });
    } catch {
      this.memory.set(key, {
        value: 1,
        expires: Date.now() + ttlSeconds * 1000,
      });
    }
  }

  private async ttl(key: string): Promise<number> {
    let remote = 0;
    try {
      remote = Math.max(0, await this.redis.ttl(key));
    } catch {
      remote = 0;
    }
    const entry = this.memory.get(key);
    const local =
      entry && entry.expires > Date.now()
        ? Math.ceil((entry.expires - Date.now()) / 1000)
        : 0;
    return Math.max(remote, local);
  }

  private async del(key: string): Promise<void> {
    this.memory.delete(key);
    try {
      await this.redis.del(key);
    } catch {
      // ohne Redis zaehlt nur der Speicher
    }
  }
}
