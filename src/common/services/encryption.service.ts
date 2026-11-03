import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const IV_LENGTH = 16; // 128 bits
const AUTH_TAG_LENGTH = 16; // 128 bits

/** AES-256-Schluessel aus einem beliebig langen Geheimnis (SHA-256). */
export function deriveEncryptionKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * AES-256-GCM. Ergebnis: Base64 aus IV + AuthTag + Chiffrat. Auch fuer
 * eigene Schluessel anderer Module (z. B. TSE_ENCRYPTION_KEY).
 */
export function encryptWithKey(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function decryptWithKey(key: Buffer, encryptedData: string): string {
  const combined = Buffer.from(encryptedData, 'base64');
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly key: Buffer;

  constructor(private readonly configService: ConfigService) {
    let encryptionKey = this.configService.get<string>(
      'TWO_FACTOR_ENCRYPTION_KEY',
    );

    if (!encryptionKey) {
      const nodeEnv = this.configService.get<string>('NODE_ENV', 'development');
      if (nodeEnv === 'production') {
        throw new Error(
          'TWO_FACTOR_ENCRYPTION_KEY environment variable is not set',
        );
      }

      // Use a default key for development only
      this.logger.warn(
        'TWO_FACTOR_ENCRYPTION_KEY not set - using development default. DO NOT USE IN PRODUCTION!',
      );
      encryptionKey = 'openeos-dev-2fa-encryption-key-32bytes!';
    }

    // Derive a proper key from the provided secret using SHA-256
    this.key = deriveEncryptionKey(encryptionKey);
  }

  /**
   * Encrypts a plaintext string using AES-256-GCM
   * Returns a base64-encoded string containing: IV + AuthTag + Ciphertext
   */
  encrypt(plaintext: string): string {
    return encryptWithKey(this.key, plaintext);
  }

  /**
   * Decrypts a base64-encoded encrypted string
   */
  decrypt(encryptedData: string): string {
    return decryptWithKey(this.key, encryptedData);
  }

  /**
   * Generates a cryptographically secure random string
   */
  generateRandomString(length: number): string {
    return crypto.randomBytes(length).toString('hex');
  }

  /**
   * Generates a secure random token (URL-safe base64)
   */
  generateSecureToken(byteLength: number = 32): string {
    return crypto.randomBytes(byteLength).toString('base64url');
  }

  /**
   * Hashes a string using SHA-256
   */
  hash(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  /**
   * Hashes a password/code with a salt using bcrypt-style approach
   * For OTP codes, we use a simpler hash since they're time-limited
   */
  hashCode(code: string): string {
    // For OTP codes, use SHA-256 with a pepper
    const pepper = this.configService.get<string>(
      'TWO_FACTOR_ENCRYPTION_KEY',
      '',
    );
    return crypto
      .createHash('sha256')
      .update(code + pepper)
      .digest('hex');
  }

  /**
   * Verifies a code against a hash
   */
  verifyCode(code: string, hash: string): boolean {
    const computedHash = this.hashCode(code);
    return crypto.timingSafeEqual(
      Buffer.from(computedHash, 'hex'),
      Buffer.from(hash, 'hex'),
    );
  }
}
