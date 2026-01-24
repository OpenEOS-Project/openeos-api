import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, IsNull } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as OTPAuth from 'otplib';
import * as QRCode from 'qrcode';
import {
  User,
  TrustedDevice,
  EmailOtp,
  TwoFactorMethod,
} from '../../database/entities';
import { EmailOtpPurpose } from '../../database/entities/email-otp.entity';
import { EncryptionService } from '../../common/services/encryption.service';
import { ErrorCodes } from '../../common/constants/error-codes';

const TOTP_WINDOW = 1; // Allow 1 step before/after for clock drift
const EMAIL_OTP_EXPIRY_MINUTES = 5;
const EMAIL_OTP_LENGTH = 6;
const RECOVERY_CODES_COUNT = 10;
const TRUSTED_DEVICE_EXPIRY_DAYS = 30;

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
  ) {
    this.issuer = this.configService.get<string>('TWO_FACTOR_ISSUER', 'OpenEOS');

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
        message: '2FA ist bereits aktiviert',
      });
    }

    // Generate a new secret
    const secret = OTPAuth.authenticator.generateSecret();

    // Generate the otpauth URL
    const otpauthUrl = OTPAuth.authenticator.keyuri(user.email, this.issuer, secret);

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
  async verifyTotpSetup(userId: string, token: string): Promise<RecoveryCodesResult> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    if (user.twoFactorEnabled) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: '2FA ist bereits aktiviert',
      });
    }

    if (!user.twoFactorSecretEncrypted) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Bitte starten Sie zuerst die 2FA-Einrichtung',
      });
    }

    // Decrypt and verify the token
    const secret = this.encryptionService.decrypt(user.twoFactorSecretEncrypted);
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
  async verifyEmailOtpSetup(userId: string, code: string): Promise<RecoveryCodesResult> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    if (user.twoFactorEnabled) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
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
   * Verify 2FA during login
   */
  async verify2FA(
    userId: string,
    code: string,
    trustDevice?: boolean,
    deviceFingerprint?: string,
    deviceInfo?: { name?: string; browser?: string; os?: string; ip?: string },
  ): Promise<boolean> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    if (!user.twoFactorEnabled) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: '2FA ist nicht aktiviert',
      });
    }

    let isValid = false;

    // Try TOTP verification first
    if (user.twoFactorMethod === TwoFactorMethod.TOTP && user.twoFactorSecretEncrypted) {
      const secret = this.encryptionService.decrypt(user.twoFactorSecretEncrypted);
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

    if (!isValid) {
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_2FA_CODE,
        message: 'Ungültiger Verifizierungscode',
      });
    }

    // Trust device if requested
    if (trustDevice && deviceFingerprint) {
      await this.trustDevice(user, deviceFingerprint, deviceInfo);
    }

    this.logger.log(`2FA verified for user: ${user.email}`);

    return true;
  }

  /**
   * Send Email OTP for login
   */
  async sendLoginOtp(userId: string): Promise<void> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    if (!user.twoFactorEnabled || user.twoFactorMethod !== TwoFactorMethod.EMAIL) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Email 2FA ist nicht aktiviert',
      });
    }

    await this.sendEmailOtp(user, EmailOtpPurpose.TWO_FACTOR_LOGIN);
  }

  /**
   * Disable 2FA
   */
  async disable2FA(userId: string, password: string): Promise<void> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    if (!user.twoFactorEnabled) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: '2FA ist nicht aktiviert',
      });
    }

    // Verify password (this should be done at controller level with bcrypt)
    // For now, we assume password is already verified

    // Clear 2FA data
    user.twoFactorEnabled = false;
    user.twoFactorMethod = null;
    user.twoFactorSecretEncrypted = null;
    user.twoFactorBackupCodesHash = null;
    await this.userRepository.save(user);

    // Remove all trusted devices
    await this.trustedDeviceRepository.delete({ userId });

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
  async regenerateRecoveryCodes(userId: string): Promise<RecoveryCodesResult> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    if (!user.twoFactorEnabled) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: '2FA ist nicht aktiviert',
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
        message: 'Gerät nicht gefunden',
      });
    }

    this.logger.log(`Trusted device removed: ${deviceId}`);
  }

  /**
   * Check if device is trusted
   */
  async isDeviceTrusted(userId: string, deviceFingerprint: string): Promise<boolean> {
    const device = await this.trustedDeviceRepository.findOne({
      where: {
        userId,
        deviceFingerprint,
      },
    });

    if (!device) return false;

    // Check if expired
    if (device.expiresAt < new Date()) {
      await this.trustedDeviceRepository.remove(device);
      return false;
    }

    // Update last used
    device.lastUsedAt = new Date();
    await this.trustedDeviceRepository.save(device);

    return true;
  }

  // Private helper methods

  private async sendEmailOtp(user: User, purpose: EmailOtpPurpose): Promise<void> {
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

    // TODO: Send email with code
    // For now, log the code (mock email service)
    this.logger.log(`Email OTP for ${user.email}: ${code}`);
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
        message: 'Code ist abgelaufen',
      });
    }

    if (otp.hasExceededAttempts()) {
      throw new BadRequestException({
        code: ErrorCodes.TOO_MANY_ATTEMPTS,
        message: 'Zu viele Versuche. Bitte fordern Sie einen neuen Code an.',
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

  private async trustDevice(
    user: User,
    deviceFingerprint: string,
    deviceInfo?: { name?: string; browser?: string; os?: string; ip?: string },
  ): Promise<void> {
    // Check if device already trusted
    let device = await this.trustedDeviceRepository.findOne({
      where: { userId: user.id, deviceFingerprint },
    });

    const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    if (device) {
      // Update existing
      device.lastUsedAt = new Date();
      device.expiresAt = expiresAt;
      if (deviceInfo) {
        device.deviceName = deviceInfo.name || device.deviceName;
        device.browser = deviceInfo.browser || device.browser;
        device.os = deviceInfo.os || device.os;
        device.ipAddress = deviceInfo.ip || device.ipAddress;
      }
    } else {
      // Create new
      device = this.trustedDeviceRepository.create({
        userId: user.id,
        deviceFingerprint,
        deviceName: deviceInfo?.name,
        browser: deviceInfo?.browser,
        os: deviceInfo?.os,
        ipAddress: deviceInfo?.ip,
        expiresAt,
      });
    }

    await this.trustedDeviceRepository.save(device);
    this.logger.log(`Device trusted for user: ${user.email}`);
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
      this.encryptionService.hashCode(code.replace(/-/g, '').toLowerCase())
    );
    return JSON.stringify(hashes);
  }

  private generateNumericCode(length: number): string {
    let code = '';
    for (let i = 0; i < length; i++) {
      code += Math.floor(Math.random() * 10).toString();
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

    this.logger.log('2FA cleanup completed');
  }
}
