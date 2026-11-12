import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'crypto';

/**
 * Bremse fuer Passwort-Anmeldungen je Konto und IP-Adresse.
 *
 * Nach `ATTEMPTS_PER_ROUND` falschen Passwoertern von derselben Adresse
 * wartet diese Adresse fuer dieses Konto: 15 Minuten, bei jeder weiteren
 * Runde doppelt so lange, hoechstens 24 Stunden. Andere Adressen (die
 * Person selbst an einem anderen Ort) sind davon nicht betroffen; dafuer
 * gibt es die Sperre des ganzen Kontos mit hoeherer Schwelle
 * (AuthService). Beides betrifft nur neue Passwort-Anmeldungen —
 * bestehende Sitzungen und der Anmeldelink bleiben.
 *
 * Gezaehlt wird im gemeinsamen Cache (Redis), damit die Grenze ueber alle
 * Instanzen gilt. Im Schluessel steht nur ein Hash von Konto und Adresse.
 */
export const ATTEMPTS_PER_ROUND = 5;
export const FIRST_BACKOFF_MS = 15 * 60 * 1000;
export const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
/** So lange merkt sich die Bremse eine Adresse nach dem letzten Fehlversuch. */
const STATE_TTL_MS = 2 * MAX_BACKOFF_MS;

interface BackoffState {
  failures: number;
  rounds: number;
  blockedUntil: number | null;
}

/** Wartezeit nach der n-ten Runde (n >= 1). */
export function backoffMs(round: number): number {
  return Math.min(
    FIRST_BACKOFF_MS * 2 ** Math.max(0, round - 1),
    MAX_BACKOFF_MS,
  );
}

@Injectable()
export class LoginBackoffService {
  private readonly logger = new Logger(LoginBackoffService.name);

  constructor(
    @Optional()
    @Inject(CACHE_MANAGER)
    private readonly cache?: Cache,
  ) {}

  private key(userId: string, ip: string | null | undefined): string {
    const hash = createHash('sha256')
      .update(`${userId}|${ip ?? 'unknown'}`)
      .digest('hex')
      .slice(0, 40);
    return `login-backoff:${hash}`;
  }

  private async read(key: string): Promise<BackoffState | null> {
    if (!this.cache) return null;
    try {
      return (await this.cache.get<BackoffState>(key)) ?? null;
    } catch (error) {
      this.logger.warn(
        `Login backoff unavailable: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async write(key: string, state: BackoffState): Promise<void> {
    if (!this.cache) return;
    try {
      await this.cache.set(key, state, STATE_TTL_MS);
    } catch (error) {
      this.logger.warn(
        `Login backoff unavailable: ${(error as Error).message}`,
      );
    }
  }

  /** Millisekunden, die diese Adresse fuer dieses Konto noch warten muss. */
  async remainingMs(
    userId: string,
    ip: string | null | undefined,
    now = Date.now(),
  ): Promise<number> {
    const state = await this.read(this.key(userId, ip));
    if (!state?.blockedUntil) return 0;
    return Math.max(0, state.blockedUntil - now);
  }

  /**
   * Zaehlt ein falsches Passwort. Gibt die neue Wartezeit zurueck, wenn
   * damit eine Runde voll ist, sonst 0.
   */
  async recordFailure(
    userId: string,
    ip: string | null | undefined,
    now = Date.now(),
  ): Promise<number> {
    const key = this.key(userId, ip);
    const state = (await this.read(key)) ?? {
      failures: 0,
      rounds: 0,
      blockedUntil: null,
    };
    state.failures += 1;
    let wait = 0;
    if (state.failures >= ATTEMPTS_PER_ROUND) {
      state.rounds += 1;
      state.failures = 0;
      wait = backoffMs(state.rounds);
      state.blockedUntil = now + wait;
    }
    await this.write(key, state);
    return wait;
  }

  /** Nach einer erfolgreichen Anmeldung von dieser Adresse. */
  async clear(userId: string, ip: string | null | undefined): Promise<void> {
    if (!this.cache) return;
    try {
      await this.cache.del(this.key(userId, ip));
    } catch (error) {
      this.logger.warn(
        `Login backoff unavailable: ${(error as Error).message}`,
      );
    }
  }
}
