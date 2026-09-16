import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from './user.entity';

/**
 * Kurzlebiger Token, mit dem sich ein Benutzer ohne Passwort anmeldet.
 *
 * Anders als der Helfer-Link (`HelperMagicLink`) liegt hier nur der
 * SHA-256-Hash in der Datenbank: dieser Token oeffnet ein Konto, und wer
 * die Tabelle lesen kann, soll sich damit nicht anmelden koennen. Der
 * Klartext existiert genau einmal — in der versendeten Mail.
 *
 * Gueltig 15 Minuten und genau einmal verwendbar (`usedAt`). Kurz, weil
 * ein Postfach laenger offen liegt als ein Browserfenster.
 */
@Entity('login_magic_links')
@Index(['tokenHash'], { unique: true })
@Index(['userId'])
export class LoginMagicLink {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;

  @Column({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'expires_at', type: 'timestamp with time zone' })
  expiresAt: Date;

  @Column({ name: 'used_at', type: 'timestamp with time zone', nullable: true })
  usedAt: Date | null;

  /** Nur zur Nachschau bei Missbrauch, nicht fuer Entscheidungen. */
  @Column({ name: 'requested_ip', type: 'varchar', length: 45, nullable: true })
  requestedIp: string | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
