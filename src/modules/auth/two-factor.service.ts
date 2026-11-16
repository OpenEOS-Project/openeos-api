import { createHash, randomBytes, randomInt } from 'crypto';
import {
  Injectable,
  BadRequestException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, IsNull, In, MoreThan } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as OTPAuth from 'otplib';
import * as QRCode from 'qrcode';
import {
  User,
  TrustedDevice,
  EmailOtp,
  TwoFactorChallenge,
  TwoFactorMethod,
} from '../../database/entities';
import { EmailOtpPurpose } from '../../database/entities/email-otp.entity';
import { EncryptionService } from '../../common/services/encryption.service';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { EmailService } from '../email/email.service';

const TOTP_WINDOW = 1; // Allow 1 step before/after for clock drift
const EMAIL_OTP_EXPIRY_MINUTES = 5;
const EMAIL_OTP_LENGTH = 6;
const RECOVERY_CODES_COUNT = 10;
const TRUSTED_DEVICE_EXPIRY_DAYS = 30;
/** Hoechstens so viele vertraute Geraete je Konto; aeltere fallen heraus. */
const MAX_TRUSTED_DEVICES_PER_USER = 20;
/** Fehlversuche je offenem zweiten Schritt, danach neu anmelden. */
export const MAX_ATTEMPTS_PER_CHALLENGE = 5;
/** Fehlversuche je Konto ueber alle offenen Schritte im Zeitfenster. */
export const MAX_FAILED_ATTEMPTS_PER_USER = 10;
export const TWO_FACTOR_LOCK_WINDOW_MINUTES = 15;
/** Geheimnis eines vertrauten Geraets: 32 Zufallsbytes, base64url. */
const TRUSTED_DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface TrustedDeviceInfo {
  name?: string;
  browser?: string;
  os?: string;
  ip?: string;
}

/** SHA-256 (hex) eines Geraete-Geheimnisses — so steht es in der Tabelle. */
export function hashTrustedDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Formal gueltiges Geraete-Geheimnis? Alles andere wird gar nicht gesucht. */
export function isWellFormedTrustedDeviceToken(token: unknown): boolean {
  return typeof token === 'string' && TRUSTED_DEVICE_TOKEN_PATTERN.test(token);
}

function invalidChallenge(): UnauthorizedException {
  return new UnauthorizedException({
    code: ErrorCodes.UNAUTHORIZED,
    reason: ErrorReasons.TWO_FACTOR_CHALLENGE_INVALID,
    message: 'Die Anmeldung ist abgelaufen. Bitte melde dich neu an.',
  });
}

function lockedError(): HttpException {
  return new HttpException(
    {
      code: ErrorCodes.TOO_MANY_ATTEMPTS,
      reason: ErrorReasons.TWO_FACTOR_LOCKED,
      message: `Zu viele falsche Codes. Bitte melde dich in ${TWO_FACTOR_LOCK_WINDOW_MINUTES} Minuten neu an.`,
      params: { minutes: TWO_FACTOR_LOCK_WINDOW_MINUTES },
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

interface TotpSetupResult {
  secret: string;
  qrCodeDataUrl: string;
  manualEntryKey: string;
}

interface RecoveryCodesResult {
  codes: string[];
}

@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);
  private readonly issuer: string;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(TrustedDevice)
    private readonly trustedDeviceRepository: Repository<TrustedDevice>,
    @InjectRepository(EmailOtp)
    private readonly emailOtpRepository: Repository<EmailOtp>,
    private readonly encryptionService: EncryptionService,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
    @InjectRepository(TwoFactorChallenge)
    private readonly challengeRepository: Repository<TwoFactorChallenge>,
  ) {
    this.issuer = this.configService.get<string>(
      'TWO_FACTOR_ISSUER',
      'OpenEOS',
    );

    // Configure otplib
    OTPAuth.authenticator.options = {
      window: TOTP_WINDOW,
    };
  }

  /**
   * Start TOTP setup - generates secret and QR code
   */
  async setupTotp(userId: string): Promise<TotpSetupResult> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    if (user.twoFactorEnabled) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.TWO_FACTOR_ALREADY_ENABLED,
        message: '2FA ist bereits aktiviert',
      });
    }

    // Generate a new secret
    const secret = OTPAuth.authenticator.generateSecret();

    // Generate the otpauth URL
    const otpauthUrl = OTPAuth.authenticator.keyuri(
      user.email,
      this.issuer,
      secret,
    );

    // Generate QR code
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    // Store encrypted secret temporarily (will be confirmed on verify)
    user.twoFactorSecretEncrypted = this.encryptionService.encrypt(secret);
    user.twoFactorMethod = TwoFactorMethod.TOTP;
    await this.userRepository.save(user);

    this.logger.log(`TOTP setup started for user: ${user.email}`);

    return {
      secret,
      qrCodeDataUrl,
      manualEntryKey: secret,
    };
  }

  /**
   * Verify TOTP setup and enable 2FA
   */
  async verifyTotpSetup(
    userId: string,
    token: string,
  ): Promise<RecoveryCodesResult> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    if (user.twoFactorEnabled) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.TWO_FACTOR_ALREADY_ENABLED,
        message: '2FA ist bereits aktiviert',
      });
    }

    if (!user.twoFactorSecretEncrypted) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.TWO_FACTOR_SETUP_NOT_STARTED,
        message: 'Bitte starte zuerst die 2FA-Einrichtung',
      });
    }

    // Decrypt and verify the token
    const secret = this.encryptionService.decrypt(
      user.twoFactorSecretEncrypted,
    );
    const isValid = OTPAuth.authenticator.verify({ token, secret });

    if (!isValid) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_2FA_CODE,
        message: 'Ungültiger Verifizierungscode',
      });
    }

    // Generate recovery codes
    const recoveryCodes = this.generateRecoveryCodes();
    const recoveryCodesHash = this.hashRecoveryCodes(recoveryCodes);

    // Enable 2FA
    user.twoFactorEnabled = true;
    user.twoFactorMethod = TwoFactorMethod.TOTP;
    user.twoFactorBackupCodesHash = recoveryCodesHash;
    await this.userRepository.save(user);

    this.logger.log(`TOTP 2FA enabled for user: ${user.email}`);

    return { codes: recoveryCodes };
  }

  /**
   * Start Email OTP setup
   */
  async setupEmailOtp(userId: string): Promise<void> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    if (user.twoFactorEnabled) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.TWO_FACTOR_ALREADY_ENABLED,
        message: '2FA ist bereits aktiviert',
      });
    }

    // Send OTP for setup verification
    await this.sendEmailOtp(user, EmailOtpPurpose.TWO_FACTOR_SETUP);

    // Mark method as email (but not enabled yet)
    user.twoFactorMethod = TwoFactorMethod.EMAIL;
    await this.userRepository.save(user);

    this.logger.log(`Email OTP setup started for user: ${user.email}`);
  }

  /**
   * Verify Email OTP setup and enable 2FA
   */
  async verifyEmailOtpSetup(
    userId: string,
    code: string,
  ): Promise<RecoveryCodesResult> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    if (user.twoFactorEnabled) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.TWO_FACTOR_ALREADY_ENABLED,
        message: '2FA ist bereits aktiviert',
      });
    }

    // Verify the OTP
    await this.verifyEmailOtp(user, code, EmailOtpPurpose.TWO_FACTOR_SETUP);

    // Generate recovery codes
    const recoveryCodes = this.generateRecoveryCodes();
    const recoveryCodesHash = this.hashRecoveryCodes(recoveryCodes);

    // Enable 2FA
    user.twoFactorEnabled = true;
    user.twoFactorMethod = TwoFactorMethod.EMAIL;
    user.twoFactorBackupCodesHash = recoveryCodesHash;
    await this.userRepository.save(user);

    this.logger.log(`Email 2FA enabled for user: ${user.email}`);

    return { codes: recoveryCodes };
  }

  /**
   * Offenen zweiten Anmeldeschritt anlegen. Die Kennung wird `jti` des
   * Ausweises (AuthService.issueTwoFactorToken).
   */
  async createChallenge(
    userId: string,
    expiresInMinutes: number,
  ): Promise<TwoFactorChallenge> {
    return this.challengeRepository.save(
      this.challengeRepository.create({
        userId,
        failedAttempts: 0,
        completedAt: null,
        expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000),
      }),
    );
  }

  /**
   * Zweiter Faktor bei der Anmeldung.
   *
   * Jeder Versuch wird vor der Pruefung des Codes gezaehlt — in einer
   * einzigen UPDATE-Anweisung, damit parallele Anfragen (auch ueber
   * mehrere API-Instanzen) die Grenze nicht unterlaufen. Nach
   * MAX_ATTEMPTS_PER_CHALLENGE Fehlversuchen ist der Schritt verbraucht;
   * ueber alle offenen Schritte eines Kontos gilt zusaetzlich
   * MAX_FAILED_ATTEMPTS_PER_USER im Zeitfenster, sonst holte man sich mit
   * dem Passwort einfach immer neue Versuche. Ein erfolgreicher Schritt
   * ist danach erledigt; sein Ausweis taugt nicht noch einmal.
   *
   * Mit `trustDevice` entsteht ein vertrautes Geraet; zurueck kommt dessen
   * Geheimnis, das der Controller als Cookie setzt.
   */
  async verify2FA(
    userId: string,
    challengeId: string | null | undefined,
    code: string,
    trustDevice?: boolean,
    deviceInfo?: TrustedDeviceInfo,
  ): Promise<{ trustedDeviceToken: string | null }> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    if (!user.twoFactorEnabled) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.TWO_FACTOR_NOT_ENABLED,
        message: '2FA ist nicht aktiviert',
      });
    }

    if (!challengeId) throw invalidChallenge();
    await this.assertUserNotLocked(userId);
    await this.reserveAttempt(userId, challengeId);

    if (!(await this.isValidSecondFactor(user, code))) {
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_2FA_CODE,
        message: 'Ungültiger Verifizierungscode',
      });
    }

    await this.completeChallenge(challengeId);

    const trustedDeviceToken = trustDevice
      ? await this.trustDevice(user, deviceInfo)
      : null;

    this.logger.log(`2FA verified for user: ${user.email}`);

    return { trustedDeviceToken };
  }

  /**
   * Ist der Schritt noch offen (nicht erledigt, nicht abgelaufen, nicht
   * ausgeschoepft) und das Konto nicht gesperrt? Fuer Endpunkte des
   * zweiten Schritts, die selbst keinen Code pruefen (Code erneut senden).
   */
  async assertChallengeOpen(
    userId: string,
    challengeId: string | null | undefined,
  ): Promise<void> {
    if (!challengeId) throw invalidChallenge();
    const challenge = await this.challengeRepository.findOne({
      where: { id: challengeId, userId },
    });
    if (
      !challenge ||
      challenge.completedAt ||
      challenge.expiresAt <= new Date()
    ) {
      throw invalidChallenge();
    }
    if (challenge.failedAttempts >= MAX_ATTEMPTS_PER_CHALLENGE) {
      throw lockedError();
    }
    await this.assertUserNotLocked(userId);
  }

  private async assertUserNotLocked(userId: string): Promise<void> {
    const rows: { failed: number | string | null }[] =
      await this.challengeRepository.query(
        `SELECT COALESCE(SUM(failed_attempts), 0) AS failed
           FROM two_factor_challenges
          WHERE user_id = $1
            AND completed_at IS NULL
            AND created_at > now() - make_interval(mins => $2)`,
        [userId, TWO_FACTOR_LOCK_WINDOW_MINUTES],
      );
    if (Number(rows[0]?.failed ?? 0) >= MAX_FAILED_ATTEMPTS_PER_USER) {
      throw lockedError();
    }
  }

  /** Zaehlt den Versuch atomar; wirft, wenn der Schritt nicht mehr gilt. */
  private async reserveAttempt(
    userId: string,
    challengeId: string,
  ): Promise<void> {
    const result: [unknown[], number] = await this.challengeRepository.query(
      `UPDATE two_factor_challenges
          SET failed_attempts = failed_attempts + 1, updated_at = now()
        WHERE id = $1 AND user_id = $2
          AND completed_at IS NULL
          AND expires_at > now()
          AND failed_attempts < $3
        RETURNING id`,
      [challengeId, userId, MAX_ATTEMPTS_PER_CHALLENGE],
    );
    if (result[1] > 0) return;

    // Kein Versuch mehr frei — warum, entscheidet ueber die Meldung.
    const challenge = await this.challengeRepository.findOne({
      where: { id: challengeId, userId },
    });
    if (
      challenge &&
      !challenge.completedAt &&
      challenge.expiresAt > new Date() &&
      challenge.failedAttempts >= MAX_ATTEMPTS_PER_CHALLENGE
    ) {
      throw lockedError();
    }
    throw invalidChallenge();
  }

  /**
   * Schritt als erledigt markieren und den vorab gezaehlten Versuch
   * zuruecknehmen. Nur einmal moeglich: ein zweiter, gleichzeitiger
   * Erfolg mit demselben Ausweis findet keine offene Zeile mehr.
   */
  private async completeChallenge(challengeId: string): Promise<void> {
    const result: [unknown[], number] = await this.challengeRepository.query(
      `UPDATE two_factor_challenges
          SET completed_at = now(),
              failed_attempts = GREATEST(failed_attempts - 1, 0),
              updated_at = now()
        WHERE id = $1 AND completed_at IS NULL
        RETURNING id`,
      [challengeId],
    );
    if (result[1] === 0) throw invalidChallenge();
  }

  /**
   * Send Email OTP for login
   */
  async sendLoginOtp(userId: string): Promise<void> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    if (
      !user.twoFactorEnabled ||
      user.twoFactorMethod !== TwoFactorMethod.EMAIL
    ) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.EMAIL_TWO_FACTOR_NOT_ENABLED,
        message: 'E-Mail-2FA ist nicht aktiviert',
      });
    }

    await this.sendEmailOtp(user, EmailOtpPurpose.TWO_FACTOR_LOGIN);
  }

  /**
   * Disable 2FA
   */
  async disable2FA(userId: string, code: string): Promise<void> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    if (!user.twoFactorEnabled) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.TWO_FACTOR_NOT_ENABLED,
        message: '2FA ist nicht aktiviert',
      });
    }

    /* Abschalten verlangt einen gueltigen Code des zweiten Faktors.

       Frueher nahm dieser Weg ein Passwort entgegen und pruefte es nicht —
       der Kommentar hier verwies auf den Controller, der es auch nicht tat.
       Wer eine angemeldete Sitzung in die Hand bekam, etwa ein offenes
       Dashboard am Vereins-Laptop, konnte die 2FA damit abschalten.

       Der Code statt des Passworts, weil er genau das belegt, worum es geht:
       den Besitz des Faktors, der abgeschaltet werden soll. Und weil es
       Konten ohne Passwort gibt (Anmeldung per Link), fuer die eine
       Passwortpruefung gar nicht moeglich waere. */
    if (!(await this.isValidSecondFactor(user, code))) {
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_2FA_CODE,
        message: 'Ungültiger Verifizierungscode',
      });
    }

    // Clear 2FA data
    user.twoFactorEnabled = false;
    user.twoFactorMethod = null;
    user.twoFactorSecretEncrypted = null;
    user.twoFactorBackupCodesHash = null;
    await this.userRepository.save(user);

    // Remove all trusted devices
    await this.revokeTrustedDevices(userId);

    this.logger.log(`2FA disabled for user: ${user.email}`);
  }

  /**
   * Get 2FA status
   */
  async get2FAStatus(userId: string): Promise<{
    enabled: boolean;
    method: TwoFactorMethod | null;
    hasRecoveryCodes: boolean;
  }> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    return {
      enabled: user.twoFactorEnabled,
      method: user.twoFactorMethod,
      hasRecoveryCodes: !!user.twoFactorBackupCodesHash,
    };
  }

  /**
   * Generate new recovery codes
   */
  async regenerateRecoveryCodes(
    userId: string,
    code: string,
  ): Promise<RecoveryCodesResult> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    if (!user.twoFactorEnabled) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.TWO_FACTOR_NOT_ENABLED,
        message: '2FA ist nicht aktiviert',
      });
    }

    /* Neue Wiederherstellungscodes sind ein dauerhafter Ersatz fuer den
       zweiten Faktor — und die Antwort liefert sie im Klartext aus. Ohne
       Pruefung bekam sie jeder, der eine angemeldete Sitzung hielt. */
    if (!(await this.isValidSecondFactor(user, code))) {
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_2FA_CODE,
        message: 'Ungültiger Verifizierungscode',
      });
    }

    const recoveryCodes = this.generateRecoveryCodes();
    const recoveryCodesHash = this.hashRecoveryCodes(recoveryCodes);

    user.twoFactorBackupCodesHash = recoveryCodesHash;
    await this.userRepository.save(user);

    this.logger.log(`Recovery codes regenerated for user: ${user.email}`);

    return { codes: recoveryCodes };
  }

  /**
   * Get trusted devices
   */
  async getTrustedDevices(userId: string): Promise<TrustedDevice[]> {
    return this.trustedDeviceRepository.find({
      where: { userId },
      order: { lastUsedAt: 'DESC' },
    });
  }

  /**
   * Remove a trusted device
   */
  async removeTrustedDevice(userId: string, deviceId: string): Promise<void> {
    const result = await this.trustedDeviceRepository.delete({
      id: deviceId,
      userId,
    });

    if (result.affected === 0) {
      throw new BadRequestException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.DEVICE_NOT_FOUND,
        message: 'Gerät nicht gefunden',
      });
    }

    this.logger.log(`Trusted device removed: ${deviceId}`);
  }

  /**
   * Vertrautes Geraet dieses Benutzers?
   *
   * Prueft die vorgelegten Geheimnisse (Cookie `trustedDevice`, hoechstens
   * fuenf) gegen die gespeicherten Hashes — nur Eintraege dieses Kontos,
   * nur nicht abgelaufene. Alles andere heisst: zweiter Faktor.
   */
  async isTrustedDevice(userId: string, tokens: string[]): Promise<boolean> {
    const hashes = tokens
      .filter(isWellFormedTrustedDeviceToken)
      .slice(0, 5)
      .map(hashTrustedDeviceToken);
    if (hashes.length === 0) return false;

    const device = await this.trustedDeviceRepository.findOne({
      where: {
        userId,
        tokenHash: In(hashes),
        expiresAt: MoreThan(new Date()),
      },
    });
    if (!device) return false;

    await this.trustedDeviceRepository.update(
      { id: device.id },
      { lastUsedAt: new Date() },
    );
    return true;
  }

  /** Alle vertrauten Geraete eines Kontos entziehen (z. B. neues Passwort). */
  async revokeTrustedDevices(userId: string): Promise<void> {
    await this.trustedDeviceRepository.delete({ userId });
  }

  // Private helper methods

  private async sendEmailOtp(
    user: User,
    purpose: EmailOtpPurpose,
  ): Promise<void> {
    // Invalidate existing OTPs for this purpose
    await this.emailOtpRepository.update(
      { userId: user.id, purpose, usedAt: IsNull() },
      { usedAt: new Date() },
    );

    // Generate new OTP
    const code = this.generateNumericCode(EMAIL_OTP_LENGTH);
    const codeHash = this.encryptionService.hashCode(code);

    const emailOtp = this.emailOtpRepository.create({
      userId: user.id,
      codeHash,
      purpose,
      expiresAt: new Date(Date.now() + EMAIL_OTP_EXPIRY_MINUTES * 60 * 1000),
    });
    await this.emailOtpRepository.save(emailOtp);

    const sent = await this.emailService.sendTwoFactorOtpEmail({
      to: user.email,
      code,
      context: purpose === EmailOtpPurpose.TWO_FACTOR_SETUP ? 'setup' : 'login',
    });
    if (!sent) {
      // Never log the code itself — a failed send must not become a second,
      // quieter way to read a live 2FA code out of the logs.
      this.logger.error(
        `Failed to send 2FA email OTP to ${user.email} (purpose: ${purpose})`,
      );
    }
  }

  /**
   * Prueft einen Code gegen den eingerichteten zweiten Faktor: TOTP bzw.
   * E-Mail-Code je nach Methode, ersatzweise einen Wiederherstellungscode.
   *
   * Gemeinsam genutzt von der Anmeldung und vom Abschalten der 2FA, damit
   * beide Wege dieselben Codes akzeptieren.
   */
  private async isValidSecondFactor(
    user: User,
    code: string,
  ): Promise<boolean> {
    let isValid = false;

    // Try TOTP verification first
    if (
      user.twoFactorMethod === TwoFactorMethod.TOTP &&
      user.twoFactorSecretEncrypted
    ) {
      const secret = this.encryptionService.decrypt(
        user.twoFactorSecretEncrypted,
      );
      isValid = OTPAuth.authenticator.verify({ token: code, secret });
    }
    // Try Email OTP
    else if (user.twoFactorMethod === TwoFactorMethod.EMAIL) {
      try {
        await this.verifyEmailOtp(user, code, EmailOtpPurpose.TWO_FACTOR_LOGIN);
        isValid = true;
      } catch {
        isValid = false;
      }
    }

    // If not valid, try recovery code
    if (!isValid) {
      isValid = await this.verifyRecoveryCode(user, code);
    }

    return isValid;
  }

  private async verifyEmailOtp(
    user: User,
    code: string,
    purpose: EmailOtpPurpose,
  ): Promise<void> {
    const otp = await this.emailOtpRepository.findOne({
      where: {
        userId: user.id,
        purpose,
        usedAt: IsNull(),
      },
      order: { createdAt: 'DESC' },
    });

    if (!otp) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_2FA_CODE,
        message: 'Kein gültiger Code gefunden',
      });
    }

    if (otp.isExpired()) {
      throw new BadRequestException({
        code: ErrorCodes.TOKEN_EXPIRED,
        reason: ErrorReasons.TWO_FACTOR_CODE_EXPIRED,
        message: 'Code ist abgelaufen',
      });
    }

    if (otp.hasExceededAttempts()) {
      throw new BadRequestException({
        code: ErrorCodes.TOO_MANY_ATTEMPTS,
        message: 'Zu viele Versuche. Bitte fordere einen neuen Code an.',
      });
    }

    const isValid = this.encryptionService.verifyCode(code, otp.codeHash);

    if (!isValid) {
      otp.attempts += 1;
      await this.emailOtpRepository.save(otp);

      throw new BadRequestException({
        code: ErrorCodes.INVALID_2FA_CODE,
        message: 'Ungültiger Code',
      });
    }

    // Mark as used
    otp.usedAt = new Date();
    await this.emailOtpRepository.save(otp);
  }

  private async verifyRecoveryCode(user: User, code: string): Promise<boolean> {
    if (!user.twoFactorBackupCodesHash) return false;

    const storedCodes = JSON.parse(user.twoFactorBackupCodesHash) as string[];
    const normalizedCode = code.replace(/-/g, '').toLowerCase();
    const codeHash = this.encryptionService.hashCode(normalizedCode);

    const index = storedCodes.indexOf(codeHash);
    if (index === -1) return false;

    // Remove used code
    storedCodes.splice(index, 1);
    user.twoFactorBackupCodesHash = JSON.stringify(storedCodes);
    await this.userRepository.save(user);

    this.logger.log(`Recovery code used for user: ${user.email}`);

    return true;
  }

  /**
   * Neues vertrautes Geraet. Das Geheimnis (256 Bit) verlaesst den Server
   * nur einmal, als Cookie; gespeichert wird sein Hash.
   */
  private async trustDevice(
    user: User,
    deviceInfo?: TrustedDeviceInfo,
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const device = this.trustedDeviceRepository.create({
      userId: user.id,
      tokenHash: hashTrustedDeviceToken(token),
      deviceName: deviceInfo?.name?.slice(0, 255) || null,
      browser: deviceInfo?.browser?.slice(0, 100) || null,
      os: deviceInfo?.os?.slice(0, 100) || null,
      ipAddress: deviceInfo?.ip?.slice(0, 45) || null,
      lastUsedAt: new Date(),
      expiresAt: new Date(
        Date.now() + TRUSTED_DEVICE_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
      ),
    });
    await this.trustedDeviceRepository.save(device);
    await this.pruneTrustedDevices(user.id);

    this.logger.log(`Device trusted for user: ${user.email}`);
    return token;
  }

  private async pruneTrustedDevices(userId: string): Promise<void> {
    const devices = await this.trustedDeviceRepository.find({
      where: { userId },
      order: { lastUsedAt: 'DESC' },
      select: { id: true },
    });
    const surplus = devices.slice(MAX_TRUSTED_DEVICES_PER_USER);
    if (surplus.length > 0) {
      await this.trustedDeviceRepository.delete({
        id: In(surplus.map((d) => d.id)),
      });
    }
  }

  private generateRecoveryCodes(): string[] {
    const codes: string[] = [];
    for (let i = 0; i < RECOVERY_CODES_COUNT; i++) {
      // Generate 8-character alphanumeric code
      const code = this.encryptionService.generateRandomString(4); // 8 hex chars
      // Format as xxxx-xxxx
      codes.push(`${code.slice(0, 4)}-${code.slice(4, 8)}`);
    }
    return codes;
  }

  private hashRecoveryCodes(codes: string[]): string {
    const hashes = codes.map((code) =>
      this.encryptionService.hashCode(code.replace(/-/g, '').toLowerCase()),
    );
    return JSON.stringify(hashes);
  }

  private generateNumericCode(length: number): string {
    let code = '';
    for (let i = 0; i < length; i++) {
      // Ziffern aus crypto statt Math.random; Format bleibt gleich.
      code += randomInt(10).toString();
    }
    return code;
  }

  /**
   * Cleanup expired OTPs and devices (to be called periodically)
   */
  async cleanup(): Promise<void> {
    const now = new Date();

    // Delete expired OTPs
    await this.emailOtpRepository.delete({
      expiresAt: LessThan(now),
    });

    // Delete expired trusted devices
    await this.trustedDeviceRepository.delete({
      expiresAt: LessThan(now),
    });

    // Delete expired login challenges
    await this.challengeRepository.delete({
      expiresAt: LessThan(now),
    });

    this.logger.log('2FA cleanup completed');
  }
}
