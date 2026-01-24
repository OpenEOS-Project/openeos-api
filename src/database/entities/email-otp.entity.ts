import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';

export enum EmailOtpPurpose {
  TWO_FACTOR_SETUP = 'two_factor_setup',
  TWO_FACTOR_LOGIN = 'two_factor_login',
  EMAIL_CHANGE = 'email_change',
}

@Entity('email_otps')
@Index(['userId', 'purpose'])
@Index(['expiresAt'])
export class EmailOtp extends BaseEntity {
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'code_hash', type: 'varchar', length: 255 })
  codeHash: string;

  @Column({ type: 'enum', enum: EmailOtpPurpose, enumName: 'email_otp_purpose' })
  purpose: EmailOtpPurpose;

  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'max_attempts', type: 'int', default: 3 })
  maxAttempts: number;

  @Column({ name: 'expires_at', type: 'timestamp with time zone' })
  expiresAt: Date;

  @Column({ name: 'used_at', type: 'timestamp with time zone', nullable: true })
  usedAt: Date | null;

  // Relations
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  // Helper methods
  isExpired(): boolean {
    return new Date() > this.expiresAt;
  }

  isUsed(): boolean {
    return this.usedAt !== null;
  }

  hasExceededAttempts(): boolean {
    return this.attempts >= this.maxAttempts;
  }
}
