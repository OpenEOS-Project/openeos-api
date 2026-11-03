import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  decryptWithKey,
  deriveEncryptionKey,
  encryptWithKey,
} from '../../common/services/encryption.service';

/**
 * Verschluesselt das Access Token einer TSE (AES-256-GCM wie
 * EncryptionService). Schluessel: `TSE_ENCRYPTION_KEY`, sonst
 * `TWO_FACTOR_ENCRYPTION_KEY` (Rueckfall, README „Cloud-TSE“). Geht der
 * Schluessel verloren, ist die TSE nicht mehr bedienbar (nur noch ueber
 * die Vendor-API deaktivierbar) — Schluessel sichern!
 */
@Injectable()
export class TseCryptoService {
  private readonly logger = new Logger(TseCryptoService.name);
  private readonly key: Buffer;

  constructor(configService: ConfigService) {
    const dedicated = (
      configService.get<string>('TSE_ENCRYPTION_KEY') ?? ''
    ).trim();
    const fallback = (
      configService.get<string>('TWO_FACTOR_ENCRYPTION_KEY') ?? ''
    ).trim();
    let secret = dedicated || fallback;
    if (!secret) {
      if (configService.get<string>('NODE_ENV') === 'production') {
        // Ohne Schluessel startet EncryptionService in Produktion ohnehin nicht.
        throw new Error(
          'TSE_ENCRYPTION_KEY (or TWO_FACTOR_ENCRYPTION_KEY) is not set',
        );
      }
      this.logger.warn(
        'TSE_ENCRYPTION_KEY not set - using development default. DO NOT USE IN PRODUCTION!',
      );
      secret = 'openeos-dev-tse-encryption-key';
    }
    this.key = deriveEncryptionKey(secret);
  }

  encrypt(plaintext: string): string {
    return encryptWithKey(this.key, plaintext);
  }

  decrypt(ciphertext: string): string {
    return decryptWithKey(this.key, ciphertext);
  }
}
