import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';

/**
 * Ein Browser, der nach bestaetigtem zweiten Faktor eine Weile ohne Code
 * anmelden darf.
 *
 * Erkannt wird er an einem zufaelligen Geheimnis, das der Server bei der
 * Bestaetigung ausgibt und als httpOnly-Cookie setzt. Gespeichert ist nur
 * der SHA-256-Hash (`tokenHash`); das Geheimnis selbst kennt allein der
 * Browser. Gebunden an das Konto: ein Geheimnis gilt nur zusammen mit dem
 * Benutzer, fuer den es ausgegeben wurde.
 */
@Entity('trusted_devices')
@Index('IDX_trusted_devices_token_hash', ['tokenHash'], { unique: true })
@Index('IDX_trusted_devices_expires_at', ['expiresAt'])
export class TrustedDevice extends BaseEntity {
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /**
   * SHA-256 (hex) des ausgegebenen Geheimnisses. Nie herausgeben. In der
   * Datenbank nullbar (Eintraege aelterer Fassungen), die API setzt ihn immer.
   */
  @Column({
    name: 'token_hash',
    type: 'varchar',
    length: 64,
    nullable: true,
    select: false,
  })
  tokenHash: string;

  @Column({ name: 'device_name', type: 'varchar', length: 255, nullable: true })
  deviceName: string | null;

  @Column({ name: 'browser', type: 'varchar', length: 100, nullable: true })
  browser: string | null;

  @Column({ name: 'os', type: 'varchar', length: 100, nullable: true })
  os: string | null;

  @Column({ name: 'ip_address', type: 'varchar', length: 45, nullable: true })
  ipAddress: string | null;

  @Column({
    name: 'last_used_at',
    type: 'timestamp with time zone',
    default: () => 'CURRENT_TIMESTAMP',
  })
  lastUsedAt: Date;

  @Column({ name: 'expires_at', type: 'timestamp with time zone' })
  expiresAt: Date;

  // Relations
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
