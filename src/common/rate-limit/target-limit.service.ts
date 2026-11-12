import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { getStorageToken, ThrottlerStorage } from '@nestjs/throttler';
import { createHash } from 'crypto';

import { ErrorCodes } from '../constants/error-codes';

/** Grenze je Ziel: hoechstens `limit` Vorgaenge in `windowMs`. */
export interface TargetLimit {
  limit: number;
  windowMs: number;
}

/**
 * Grenzen je Empfaenger fuer Vorgaenge, die eine E-Mail ausloesen
 * (Passwort vergessen, Anmeldelink, Helferanmeldung, Beleg per E-Mail …).
 * Ergaenzt die Grenze je IP-Adresse des globalen Rate-Limits: dieselbe
 * Adresse bekommt nur eine begrenzte Zahl an Mails, egal von wo die
 * Anfragen kommen.
 *
 * Zaehlt im Speicher des Rate-Limits (Redis, gemeinsam fuer alle
 * Instanzen). Im Schluessel steht nur ein Hash des Ziels, keine Adresse.
 */
@Injectable()
export class TargetLimitService {
  private readonly logger = new Logger(TargetLimitService.name);

  constructor(
    @Optional()
    @Inject(getStorageToken())
    private readonly storage?: ThrottlerStorage,
  ) {}

  /**
   * Zaehlt einen Vorgang fuer `target` in `scope` und sagt, ob er noch
   * innerhalb der Grenze liegt. Ohne Speicher (Tests) immer `true`.
   */
  async allow(
    scope: string,
    target: string,
    { limit, windowMs }: TargetLimit,
  ): Promise<boolean> {
    if (!this.storage) return true;
    const normalized = target.trim().toLowerCase();
    if (!normalized) return true;
    const hash = createHash('sha256')
      .update(normalized)
      .digest('hex')
      .slice(0, 32);
    const record = await this.storage.increment(
      `${scope}:${hash}`,
      windowMs,
      limit,
      windowMs,
      'target',
    );
    if (record.isBlocked) {
      this.logger.log(`Limit reached for ${scope}`);
      return false;
    }
    return true;
  }

  /** Wie allow(), antwortet aber mit 429, wenn die Grenze erreicht ist. */
  async assert(
    scope: string,
    target: string,
    limit: TargetLimit,
    message = 'Zu viele Anfragen. Bitte versuche es später noch einmal.',
  ): Promise<void> {
    if (await this.allow(scope, target, limit)) return;
    throw new HttpException(
      {
        code: ErrorCodes.RATE_LIMITED,
        message,
        params: { limit: limit.limit },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Grenzen je Ziel fuer die E-Mail-Vorgaenge. */
export const TARGET_LIMITS = {
  /** Passwort vergessen: je Adresse. */
  passwordReset: { limit: 3, windowMs: 60 * 60 * 1000 },
  /** Bestaetigungsmail erneut senden: je Adresse. */
  verificationResend: { limit: 3, windowMs: 60 * 60 * 1000 },
  /** Anmeldelink per E-Mail: je Adresse. */
  loginMagicLink: { limit: 5, windowMs: 60 * 60 * 1000 },
  /** Helfer-Anmeldung zu Schichten: je Adresse. */
  shiftSignUp: { limit: 10, windowMs: 60 * 60 * 1000 },
  /** Helfer-Link zum Verwalten der eigenen Schichten: je Adresse. */
  helperMagicLink: { limit: 5, windowMs: 60 * 60 * 1000 },
  /** Beleg per E-Mail: je Empfaenger. */
  receiptEmail: { limit: 10, windowMs: 60 * 60 * 1000 },
  /** Kontaktformular: Benachrichtigungen je Absenderadresse. */
  contactSender: { limit: 3, windowMs: 60 * 60 * 1000 },
  /** Kontaktformular: Benachrichtigungen insgesamt. */
  contactTotal: { limit: 60, windowMs: 60 * 60 * 1000 },
  /** Neue Einladung: je Adresse. */
  invitation: { limit: 5, windowMs: 24 * 60 * 60 * 1000 },
  /** Einladung erneut senden: je Einladung. */
  invitationResend: { limit: 3, windowMs: 60 * 60 * 1000 },
} as const satisfies Record<string, TargetLimit>;
