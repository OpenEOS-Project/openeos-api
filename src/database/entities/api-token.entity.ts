import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';

/**
 * Ein Zugang für Maschinen.
 *
 * Ein Anmeldetoken hält eine Stunde, hängt am Passwort und künftig am
 * zweiten Faktor — für eine Überwachung, die alle fünf Minuten fragt,
 * taugt er nicht. Ein API-Token hat einen eigenen Lebenslauf: er lässt
 * sich einzeln widerrufen, ohne die Anmeldung seines Besitzers
 * anzutasten, und trägt nur die Rechte, die ausdrücklich dranstehen.
 *
 * Gespeichert wird allein der Hash. Der Token selbst erscheint genau
 * einmal, bei der Ausstellung; danach kann ihn auch niemand mehr aus der
 * Datenbank holen, der sie liest.
 */
@Entity('api_tokens')
@Index(['tokenHash'], { unique: true })
export class ApiToken extends BaseEntity {
  /** Wofür der Token gedacht ist — steht in der Übersicht. */
  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash: string;

  /** Die ersten Zeichen im Klartext, damit sich ein Token wiedererkennen lässt. */
  @Column({ name: 'token_prefix', type: 'varchar', length: 16 })
  tokenPrefix: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /** Was der Token darf. Leer heisst: nichts. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  scopes: string[];

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;
}
