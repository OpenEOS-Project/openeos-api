import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
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

/** Abrechnen (Verwaltung und Kasse), bedienungen-plan.md §7. */
export class SettleWaiterDto {
  @ApiPropertyOptional({
    description:
      'Veranstaltung. Ohne: die der Bedienung (veranstaltungsgebunden), sonst die laufende.',
  })
  @IsOptional()
  @IsUUIDLoose()
  eventId?: string;

  @ApiPropertyOptional({
    example: 120.5,
    nullable: true,
    description:
      'Gezählter Bargeldbestand (optional). Ohne Kellnerbrieftasche ist „Soll bar“ nur informativ.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  countedCash?: number | null;

  @ApiPropertyOptional({
    description:
      'Trotz offener Tische abrechnen (nur Schichtleitung/Admin, mit `note`).',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;

  @ApiPropertyOptional({ maxLength: 500 })
  @Transform(trimOrNull)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;

  @ApiPropertyOptional({
    description:
      'Drucker für den Abrechnungsbon (Verwaltung). Ohne: kein Druck.',
  })
  @IsOptional()
  @IsUUIDLoose()
  printerId?: string;
}

/** Abrechnen an der Kasse: optional eine andere Bedienung (Schichtleitung). */
export class DeviceSettleWaiterDto extends SettleWaiterDto {
  @ApiPropertyOptional({
    description:
      'Andere Bedienung abrechnen (Schichtleitung). Ohne: sich selbst.',
  })
  @IsOptional()
  @IsUUIDLoose()
  waiterId?: string;

  @ApiPropertyOptional({ default: true, description: 'Bon drucken' })
  @IsOptional()
  @IsBoolean()
  print?: boolean;
}

export class PrintWaiterSummaryDto {
  @ApiPropertyOptional({ description: 'Andere Bedienung (Schichtleitung).' })
  @IsOptional()
  @IsUUIDLoose()
  waiterId?: string;
}

export class ReprintSettlementDto {
  @ApiPropertyOptional({
    description: 'Drucker. Ohne: Bondrucker des Geräts der Abrechnung.',
  })
  @IsOptional()
  @IsUUIDLoose()
  printerId?: string;
}

/** Tisch bzw. Bestellung an eine andere Bedienung übergeben. */
export class TransferOrderDto {
  @ApiProperty({ description: 'Neue verantwortliche Bedienung' })
  @IsUUIDLoose()
  toWaiterId: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'Alle offenen Bestellungen desselben Tisches dieser Bedienung mit übergeben.',
  })
  @IsOptional()
  @IsBoolean()
  wholeTable?: boolean;
}

/** Verwaltung: alle offenen Tische einer Bedienung übergeben. */
export class TransferTablesDto {
  @ApiProperty({ description: 'Neue verantwortliche Bedienung' })
  @IsUUIDLoose()
  toWaiterId: string;

  @ApiPropertyOptional({ description: 'Nur diese Veranstaltung' })
  @IsOptional()
  @IsUUIDLoose()
  eventId?: string;
}
