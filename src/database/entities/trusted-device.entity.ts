import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';

@Entity('trusted_devices')
@Index(['userId', 'deviceFingerprint'], { unique: true })
@Index(['expiresAt'])
export class TrustedDevice extends BaseEntity {
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'device_fingerprint', type: 'varchar', length: 255 })
  deviceFingerprint: string;

  @Column({ name: 'device_name', type: 'varchar', length: 255, nullable: true })
  deviceName: string | null;

  @Column({ name: 'browser', type: 'varchar', length: 100, nullable: true })
  browser: string | null;

  @Column({ name: 'os', type: 'varchar', length: 100, nullable: true })
  os: string | null;

  @Column({ name: 'ip_address', type: 'varchar', length: 45, nullable: true })
  ipAddress: string | null;

  @Column({ name: 'last_used_at', type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  lastUsedAt: Date;

  @Column({ name: 'expires_at', type: 'timestamp with time zone' })
  expiresAt: Date;

  // Relations
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
