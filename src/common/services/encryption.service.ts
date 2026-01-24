import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly algorithm = 'aes-256-gcm';
  private readonly keyLength = 32; // 256 bits
  private readonly ivLength = 16; // 128 bits
  private readonly authTagLength = 16; // 128 bits
  private readonly key: Buffer;

  constructor(private readonly configService: ConfigService) {
    let encryptionKey = this.configService.get<string>('TWO_FACTOR_ENCRYPTION_KEY');

    if (!encryptionKey) {
      const nodeEnv = this.configService.get<string>('NODE_ENV', 'development');
      if (nodeEnv === 'production') {
        throw new Error('TWO_FACTOR_ENCRYPTION_KEY environment variable is not set');
      }

      // Use a default key for development only
      this.logger.warn(
        'TWO_FACTOR_ENCRYPTION_KEY not set - using development default. DO NOT USE IN PRODUCTION!'
      );
      encryptionKey = 'openeos-dev-2fa-encryption-key-32bytes!';
    }

    // Derive a proper key from the provided secret using SHA-256
    this.key = crypto.createHash('sha256').update(encryptionKey).digest();
  }

  /**
   * Encrypts a plaintext string using AES-256-GCM
   * Returns a base64-encoded string containing: IV + AuthTag + Ciphertext
   */
  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(this.ivLength);
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    const authTag = cipher.getAuthTag();

    // Combine IV + AuthTag + Ciphertext
    const combined = Buffer.concat([
      iv,
      authTag,
      Buffer.from(encrypted, 'base64'),
    ]);

    return combined.toString('base64');
  }

  /**
   * Decrypts a base64-encoded encrypted string
   */
  decrypt(encryptedData: string): string {
    const combined = Buffer.from(encryptedData, 'base64');

    // Extract IV, AuthTag, and Ciphertext
    const iv = combined.subarray(0, this.ivLength);
    const authTag = combined.subarray(this.ivLength, this.ivLength + this.authTagLength);
    const ciphertext = combined.subarray(this.ivLength + this.authTagLength);

    const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString('utf8');
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
    const pepper = this.configService.get<string>('TWO_FACTOR_ENCRYPTION_KEY', '');
    return crypto.createHash('sha256').update(code + pepper).digest('hex');
  }

  /**
   * Verifies a code against a hash
   */
  verifyCode(code: string, hash: string): boolean {
    const computedHash = this.hashCode(code);
    return crypto.timingSafeEqual(
      Buffer.from(computedHash, 'hex'),
      Buffer.from(hash, 'hex')
    );
  }
}
