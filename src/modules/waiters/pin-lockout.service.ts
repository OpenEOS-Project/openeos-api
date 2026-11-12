import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { REDIS_CLIENT } from '../../common/redis/redis.constants';
import type { RedisClient } from '../../common/redis/redis.constants';
import { Device } from '../../database/entities/device.entity';

/**
 * Sperre nach Fehlversuchen bei der PIN-Eingabe (bedienungen-plan.md §11).
 *
 * Gezaehlt wird in gleitenden Zeitfenstern — jeder Fehlversuch zaehlt so
 * lange mit, bis er aus dem Fenster faellt. Eine richtige PIN setzt die
 * Zaehler nicht zurueck: sie sagt nichts ueber die vorherigen Eingaben aus,
 * die ja zu anderen PINs gehoert haben koennen.
 *
 * - je Geraet (Fenster 30 min): ab 5 Fehlversuchen sperrt jeder weitere
 *   die Eingabe, beginnend mit 30 s und jeweils doppelt so lange (hoechstens
 *   15 min); ab 20 Fehlversuchen bleibt die PIN-Eingabe gesperrt, bis ein
 *   Admin sie freigibt (`settings.waiterPinLockedAt`).
 * - je Organisation (Fenster 60 min): ab 50 Fehlversuchen auf allen Geraeten
 *   zusammen sperrt jeder weitere alle PIN-Eingaben der Organisation,
 *   beginnend mit 60 s und jeweils doppelt so lange (hoechstens 15 min).
 *
 * Nach Ablauf einer Sperre funktioniert eine richtige PIN sofort wieder.
 * Zaehler liegen in Redis (alle API-Instanzen); faellt Redis aus, zaehlt
 * die Instanz im Speicher weiter. Die Admin-Sperre steht in der Datenbank.
 */
export const DEVICE_WINDOW_SECONDS = 30 * 60;
export const DEVICE_FIRST_LOCK_AT = 5;
export const DEVICE_FIRST_LOCK_SECONDS = 30;
export const DEVICE_ADMIN_LOCK_AT = 20;
export const ORG_WINDOW_SECONDS = 60 * 60;
export const ORG_FAILURE_LIMIT = 50;
export const ORG_FIRST_LOCK_SECONDS = 60;
export const MAX_LOCK_SECONDS = 15 * 60;

/** Gleitendes Fenster: alte Eintraege entfernen, neuen zaehlen. */
const COUNT_IN_WINDOW = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return redis.call('ZCARD', KEYS[1])
`;

export interface FailureOutcome {
  /** Fehlversuche des Geraets im Zeitfenster. */
  failures: number;
  /** Fehlversuche bis zur ersten Sperre (0 = jeder weitere sperrt). */
  remainingAttempts: number;
  /** Gerade gesperrt fuer so viele Sekunden (null = bis zur Freigabe). */
  lockedForSeconds: number | null | undefined;
}

/** Doppelt so lange je Fehlversuch ab `firstAt`, gedeckelt. */
export function backoffSeconds(
  failures: number,
  firstAt: number,
  firstSeconds: number,
): number | undefined {
  if (failures < firstAt) return undefined;
  const steps = Math.min(failures - firstAt, 20);
  return Math.min(MAX_LOCK_SECONDS, firstSeconds * 2 ** steps);
}

export function remainingAttempts(failures: number): number {
  return Math.max(0, DEVICE_FIRST_LOCK_AT - failures);
}

/** Sperre des Geraets nach so vielen Fehlversuchen (null = bis zur Freigabe). */
export function lockFor(failures: number): number | null | undefined {
  if (failures >= DEVICE_ADMIN_LOCK_AT) return null;
  return backoffSeconds(
    failures,
    DEVICE_FIRST_LOCK_AT,
    DEVICE_FIRST_LOCK_SECONDS,
  );
}

/** Sperre der Organisation nach so vielen Fehlversuchen im Fenster. */
export function orgLockFor(failures: number): number | undefined {
  return backoffSeconds(
    failures,
    ORG_FAILURE_LIMIT + 1,
    ORG_FIRST_LOCK_SECONDS,
  );
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
  /** Rueckfall ohne Redis fuer die Zeitfenster: Schluessel → Zeitstempel. */
  private readonly memoryWindows = new Map<string, number[]>();

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
    const failures = await this.countFailure(
      `waiter-pin:fails:${device.id}`,
      DEVICE_WINDOW_SECONDS,
    );
    if (device.organizationId) {
      const orgFailures = await this.countFailure(
        `waiter-pin:orgfails:${device.organizationId}`,
        ORG_WINDOW_SECONDS,
      );
      const orgLock = orgLockFor(orgFailures);
      if (orgLock !== undefined) {
        await this.extendLock(
          `waiter-pin:orglock:${device.organizationId}`,
          orgLock,
        );
        this.logger.warn(
          `PIN entry of organization ${device.organizationId} paused for ${orgLock}s: ${orgFailures} failures in ${ORG_WINDOW_SECONDS / 60} min`,
        );
      }
    }
    const lock = lockFor(failures);
    if (lock === null) {
      await this.lockDevice(device);
      await this.del(`waiter-pin:fails:${device.id}`);
    } else if (lock !== undefined) {
      await this.extendLock(`waiter-pin:lock:${device.id}`, lock);
      this.logger.warn(
        `PIN entry on device ${device.id} locked for ${lock}s after ${failures} failures in ${DEVICE_WINDOW_SECONDS / 60} min`,
      );
    }
    return {
      failures,
      remainingAttempts: remainingAttempts(failures),
      lockedForSeconds: lock,
    };
  }

  /**
   * Freigabe durch einen Admin: auch eine noch laufende zeitliche Sperre
   * und die gezaehlten Fehlversuche des Geraets entfallen.
   */
  async releaseDevice(deviceId: string): Promise<void> {
    await this.del(`waiter-pin:lock:${deviceId}`);
    await this.del(`waiter-pin:fails:${deviceId}`);
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

  /** Uhr fuer die Zeitfenster (in Tests ersetzbar). */
  now: () => number = () => Date.now();

  /**
   * Fehlversuch im gleitenden Fenster vermerken und die Anzahl im Fenster
   * liefern. In Redis als Sorted Set (Zeitstempel), atomar per Skript.
   */
  private async countFailure(
    key: string,
    windowSeconds: number,
  ): Promise<number> {
    const now = this.now();
    const since = now - windowSeconds * 1000;
    const member = `${now}:${randomBytes(6).toString('hex')}`;
    try {
      const count = await this.redis.eval(COUNT_IN_WINDOW, {
        keys: [key],
        arguments: [String(since), String(now), member, String(windowSeconds)],
      });
      return Number(count);
    } catch (error) {
      this.logger.warn(
        `PIN lockout without Redis: ${(error as Error).message}`,
      );
      const recent = (this.memoryWindows.get(key) ?? []).filter(
        (at) => at > since,
      );
      recent.push(now);
      this.memoryWindows.set(key, recent);
      return recent.length;
    }
  }

  /** Sperre setzen; eine laufende laengere Sperre bleibt bestehen. */
  private async extendLock(key: string, ttlSeconds: number): Promise<void> {
    if ((await this.ttl(key)) >= ttlSeconds) return;
    try {
      await this.redis.set(key, '1', { EX: ttlSeconds });
    } catch {
      this.memory.set(key, {
        value: 1,
        expires: this.now() + ttlSeconds * 1000,
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
    const now = this.now();
    const local =
      entry && entry.expires > now
        ? Math.ceil((entry.expires - now) / 1000)
        : 0;
    return Math.max(remote, local);
  }

  private async del(key: string): Promise<void> {
    this.memory.delete(key);
    this.memoryWindows.delete(key);
    try {
      await this.redis.del(key);
    } catch {
      // ohne Redis zaehlt nur der Speicher
    }
  }
}
