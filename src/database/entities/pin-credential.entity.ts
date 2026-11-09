import { Column, Entity, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';

export type PinOwnerType = 'member' | 'waiter';

/**
 * Eine PIN je Mitglied (`owner_id` = `user_organizations.id`) bzw.
 * Bedienung (`owner_id` = `waiters.id`) in einem gemeinsamen PIN-Raum je
 * Organisation. `pinLookup` = HMAC-SHA256(PIN_PEPPER, "<orgId>:<pin>") als
 * Hex; der Klartext wird nie gespeichert. `pepperId` ist der Fingerabdruck
 * des Peppers, mit dem der Eintrag entstand (Pepper gewechselt → Eintrag
 * gilt nicht mehr, PIN neu vergeben).
 */
@Entity('pin_credentials')
@Unique('UQ_pin_credentials_lookup', ['organizationId', 'pinLookup'])
@Unique('UQ_pin_credentials_owner', ['ownerType', 'ownerId'])
export class PinCredential extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'owner_type', type: 'varchar', length: 10 })
  ownerType: PinOwnerType;

  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId: string;

  @Column({ name: 'pin_lookup', type: 'char', length: 64 })
  pinLookup: string;

  @Column({ name: 'pepper_id', type: 'char', length: 8 })
  pepperId: string;

  @Column({ name: 'pin_length', type: 'smallint' })
  pinLength: number;
}
