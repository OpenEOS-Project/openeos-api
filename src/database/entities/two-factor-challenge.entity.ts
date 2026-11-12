import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';

/**
 * Ein offener zweiter Anmeldeschritt.
 *
 * Entsteht, wenn Passwort oder Anmeldelink stimmen und noch ein Code
 * fehlt. Die Kennung steht als `jti` im Ausweis fuer den zweiten Schritt;
 * daran haengen die Zahl der Fehlversuche und das Ende. Ein Schritt gilt
 * genau einmal: nach Erfolg (`completedAt`) taugt der Ausweis nicht mehr.
 */
@Entity('two_factor_challenges')
@Index('IDX_two_factor_challenges_user_created', ['userId', 'createdAt'])
export class TwoFactorChallenge extends BaseEntity {
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'failed_attempts', type: 'int', default: 0 })
  failedAttempts: number;

  @Column({ name: 'expires_at', type: 'timestamp with time zone' })
  expiresAt: Date;

  @Column({
    name: 'completed_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  completedAt: Date | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
