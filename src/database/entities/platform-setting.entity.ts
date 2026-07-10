import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

/**
 * Generic key/value store for platform-wide (super-admin) settings.
 * One row per setting `key`; `value` holds an arbitrary JSON payload.
 */
@Entity('platform_settings')
export class PlatformSetting {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  key: string;

  @Column({ type: 'jsonb', default: {} })
  value: Record<string, unknown>;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
