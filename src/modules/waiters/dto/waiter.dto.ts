import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsUUIDLoose } from '../../../common/validators/is-uuid-loose.validator';
import {
  WAITER_ROLES,
  type WaiterPermissions,
  type WaiterRole,
} from '../../../database/entities/waiter.entity';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimOrNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

/** Höchstzahl je Massenanlage (gleich der Standardgrenze je Organisation). */
export const WAITER_BULK_MAX = 200;
export const WAITER_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export class CreateWaiterDto {
  @ApiProperty({ example: 'Anna Berger', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ example: 'Anna', maxLength: 12, nullable: true })
  @Transform(trimOrNull)
  @IsOptional()
  @IsString()
  @MaxLength(12)
  shortName?: string | null;

  @ApiPropertyOptional({ example: '#2f7d32', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(WAITER_COLOR_PATTERN)
  color?: string | null;

  @ApiPropertyOptional({ enum: WAITER_ROLES, default: 'service' })
  @IsOptional()
  @IsIn(WAITER_ROLES)
  role?: WaiterRole;

  @ApiPropertyOptional({
    description:
      'Abweichungen von der Rolle: `refund`, `cashDrawer`, `discount`, `cashbook` (je true/false)',
    example: { refund: true },
  })
  @IsOptional()
  @IsObject()
  permissions?: WaiterPermissions;

  @ApiPropertyOptional({
    description: 'Nur für diese Veranstaltung (leer = organisationsweit)',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUIDLoose()
  eventId?: string | null;

  @ApiPropertyOptional({
    description:
      'Eigene PIN (4–6 Ziffern). Ohne: vom System erzeugt. Antwort enthält die PIN einmalig.',
    example: '3958',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4,6}$/)
  pin?: string;
}

export class UpdateWaiterDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ maxLength: 12, nullable: true })
  @Transform(trimOrNull)
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(12)
  shortName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(WAITER_COLOR_PATTERN)
  color?: string | null;

  @ApiPropertyOptional({ enum: WAITER_ROLES })
  @IsOptional()
  @IsIn(WAITER_ROLES)
  role?: WaiterRole;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  permissions?: WaiterPermissions;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUIDLoose()
  eventId?: string | null;

  @ApiPropertyOptional({
    description: 'false = deaktivieren (PIN gelöscht, Sitzungen beendet)',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class BulkWaiterItemDto {
  @ApiProperty({ example: 'Ben Krämer' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ example: 'Ben' })
  @Transform(trimOrNull)
  @IsOptional()
  @IsString()
  @MaxLength(12)
  shortName?: string | null;

  @ApiPropertyOptional({ enum: WAITER_ROLES })
  @IsOptional()
  @IsIn(WAITER_ROLES)
  role?: WaiterRole;
}

export class BulkCreateWaitersDto {
  @ApiPropertyOptional({
    description: 'Nur für diese Veranstaltung (leer = organisationsweit)',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUIDLoose()
  eventId?: string | null;

  @ApiPropertyOptional({ enum: WAITER_ROLES, default: 'service' })
  @IsOptional()
  @IsIn(WAITER_ROLES)
  role?: WaiterRole;

  @ApiProperty({ type: [BulkWaiterItemDto], maxItems: WAITER_BULK_MAX })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WAITER_BULK_MAX)
  @ValidateNested({ each: true })
  @Type(() => BulkWaiterItemDto)
  items: BulkWaiterItemDto[];
}

export class ResetWaiterPinDto {
  @ApiPropertyOptional({
    description: 'Eigene PIN (4–6 Ziffern). Ohne: vom System erzeugt.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4,6}$/)
  pin?: string;
}

export class WaiterSessionLoginDto {
  @ApiProperty({ example: '3958', description: 'PIN (4–6 Ziffern)' })
  @IsString()
  @Matches(/^\d{4,6}$/)
  pin: string;
}

export const WAITER_SESSION_END_INPUT = [
  'lock',
  'switch',
  'timeout',
  'logout',
] as const;

export class WaiterSessionEndDto {
  @ApiPropertyOptional({ enum: WAITER_SESSION_END_INPUT, default: 'lock' })
  @IsOptional()
  @IsIn(WAITER_SESSION_END_INPUT)
  reason?: (typeof WAITER_SESSION_END_INPUT)[number];
}
