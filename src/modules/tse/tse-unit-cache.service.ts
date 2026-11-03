import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TseUnit } from '../../database/entities/tse-unit.entity';
import { isIntegrationEnabled } from '../integrations/integration-catalog';
import type { TseCredentials } from './swissbit/swissbit.types';
import { TseCryptoService } from './tse-crypto.service';

/** Alles, was eine Signatur braucht (Access Token entschluesselt). */
export interface SigningUnit {
  unit: TseUnit;
  credentials: TseCredentials;
}

const POSITIVE_TTL_MS = 60_000;
// Kurz: aktiviert eine andere Instanz die TSE, signiert diese nach
// spaetestens 5 s mit (Bargeld ist ab dann erlaubt).
const NEGATIVE_TTL_MS = 5_000;

/**
 * Cache der aktiven TSE je Organisation. Ohne aktive TSE (oder mit
 * ausgeschalteter Integration) liefert `get` null — dann wird nichts
 * signiert, und der Verkauf laeuft wie bisher. Der Cache spart je Verkauf
 * die Abfrage und das Entschluesseln; Zustandswechsel auf dieser Instanz
 * rufen `invalidate`.
 */
@Injectable()
export class TseUnitCache {
  private readonly entries = new Map<
    string,
    { value: SigningUnit | null; expiresAt: number }
  >();

  constructor(
    @InjectRepository(TseUnit)
    private readonly unitRepository: Repository<TseUnit>,
    private readonly crypto: TseCryptoService,
  ) {}

  async get(organizationId: string): Promise<SigningUnit | null> {
    const cached = this.entries.get(organizationId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await this.load(organizationId);
    this.entries.set(organizationId, {
      value,
      expiresAt: Date.now() + (value ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
    });
    return value;
  }

  invalidate(organizationId?: string): void {
    if (organizationId) this.entries.delete(organizationId);
    else this.entries.clear();
  }

  private async load(organizationId: string): Promise<SigningUnit | null> {
    const unit = await this.unitRepository
      .createQueryBuilder('unit')
      .addSelect('unit.accessTokenEnc')
      .innerJoin('unit.organization', 'org')
      .addSelect(['org.id', 'org.settings', 'org.country'])
      .where('unit.organizationId = :organizationId', { organizationId })
      .andWhere(`unit.state = 'active'`)
      .getOne();
    if (!unit?.serialNumber || !unit.accessTokenEnc) return null;
    if (!isIntegrationEnabled(unit.organization?.settings, 'tse')) return null;
    return {
      unit,
      credentials: {
        serialNumber: unit.serialNumber,
        accessToken: this.crypto.decrypt(unit.accessTokenEnc),
      },
    };
  }
}
