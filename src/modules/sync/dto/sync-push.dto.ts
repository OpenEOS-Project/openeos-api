import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumberString,
  IsObject,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

const SYNCABLE_TABLES = [
  'orders',
  'order_items',
  'payments',
  'print_jobs',
] as const;

export class SyncPushRowDto {
  @ApiProperty({ enum: SYNCABLE_TABLES })
  @IsIn(SYNCABLE_TABLES)
  entityType: (typeof SYNCABLE_TABLES)[number];

  @ApiProperty()
  @IsUUID()
  entityId: string;

  @ApiProperty({
    description:
      'sync_version as a string — bigint precision would be lost as a JS number',
  })
  @IsNumberString()
  syncVersion: string;

  @ApiProperty({ description: 'Full entity snapshot as written by the box' })
  @IsObject()
  @IsNotEmpty()
  payload: Record<string, unknown>;
}

export class SyncPushDto {
  @ApiProperty({ type: [SyncPushRowDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SyncPushRowDto)
  rows: SyncPushRowDto[];
}
