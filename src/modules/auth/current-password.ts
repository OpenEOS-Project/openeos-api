import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';

/**
 * Bestaetigung mit dem aktuellen Passwort fuer heikle Schritte am eigenen
 * Konto (Passwort aendern, E-Mail-Adresse aendern).
 *
 * Konten ohne Passwort (nur Anmeldelink) koennen keins liefern; fuer sie
 * traegt die angemeldete Sitzung allein — in die kommt nur, wer einen Link
 * aus dem eigenen Postfach geholt hat. Hat das Konto eins, ist es Pflicht.
 * Die Oberflaeche erkennt den Fall an `hasPassword` in GET /auth/me.
 */
export async function assertCurrentPassword(
  passwordHash: string | null | undefined,
  given: string | null | undefined,
): Promise<void> {
  if (!passwordHash) return;
  if (!given) {
    throw new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      reason: ErrorReasons.CURRENT_PASSWORD_REQUIRED,
      message: 'Gib dein aktuelles Passwort ein',
    });
  }
  if (!(await bcrypt.compare(given, passwordHash))) {
    throw new BadRequestException({
      code: ErrorCodes.INVALID_CREDENTIALS,
      reason: ErrorReasons.PASSWORD_INCORRECT,
      message: 'Aktuelles Passwort ist falsch',
    });
  }
}
