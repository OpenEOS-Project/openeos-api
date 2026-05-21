import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { ShiftPlan } from './shift-plan.entity';

/**
 * Short-lived token that lets a helper edit their own registrations in a
 * specific shift plan without an account. Issued by the public 'request
 * magic link' endpoint, validated by the manage endpoints, expires after
 * 24h. Single-use is enforced via `usedAt`: once the helper opens the
 * link the token stays valid for the duration of their session but isn't
 * re-usable for fresh sessions afterwards (we issue a new token then).
 */
@Entity('helper_magic_links')
@Index(['token'], { unique: true })
@Index(['email', 'shiftPlanId'])
export class HelperMagicLink {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;

  @Column({ type: 'varchar', length: 64 })
  token: string;

  @Column({ name: 'shift_plan_id', type: 'uuid' })
  shiftPlanId: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ name: 'expires_at', type: 'timestamp with time zone' })
  expiresAt: Date;

  @Column({ name: 'used_at', type: 'timestamp with time zone', nullable: true })
  usedAt: Date | null;

  @ManyToOne(() => ShiftPlan, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'shift_plan_id' })
  shiftPlan: ShiftPlan;
}
