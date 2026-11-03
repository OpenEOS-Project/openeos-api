import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class DsfinvkExportQueryDto {
  @ApiPropertyOptional({
    description: 'Erster Geschäftstag (YYYY-MM-DD, 6–6 Uhr), inklusive',
    example: '2026-11-01',
  })
  @IsOptional()
  @Matches(DATE)
  from?: string;

  @ApiPropertyOptional({
    description:
      'Letzter Geschäftstag (YYYY-MM-DD), inklusive; Standard = `from`',
    example: '2026-11-03',
  })
  @IsOptional()
  @Matches(DATE)
  to?: string;

  @ApiPropertyOptional({ description: 'Statt Datum: erste Z-Nummer' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  zFrom?: number;

  @ApiPropertyOptional({
    description: 'Statt Datum: letzte Z-Nummer (Standard = `zFrom`)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  zTo?: number;
}

export class DsfinvkClosingsQueryDto {
  @ApiPropertyOptional({ description: 'Ab Geschäftstag (YYYY-MM-DD)' })
  @IsOptional()
  @Matches(DATE)
  from?: string;

  @ApiPropertyOptional({ description: 'Bis Geschäftstag (YYYY-MM-DD)' })
  @IsOptional()
  @Matches(DATE)
  to?: string;

  @ApiPropertyOptional({ default: 100, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export const CASHBOOK_ACTIONS = [
  'opening_balance',
  'deposit',
  'withdrawal',
  'cash_count',
] as const;

export class CreateCashbookEntryDto {
  @ApiProperty({
    enum: CASHBOOK_ACTIONS,
    description:
      '`opening_balance` Anfangsbestand (Wechselgeld), `deposit` Einlage, `withdrawal` Entnahme/Abschöpfung, `cash_count` Kassensturz (gezählter Bestand)',
  })
  @IsIn(CASHBOOK_ACTIONS)
  type: (typeof CASHBOOK_ACTIONS)[number];

  @ApiProperty({
    description:
      'Betrag in Euro, immer positiv (bei `cash_count` der gezählte Bestand)',
    example: 150,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100000)
  amount: number;

  @ApiPropertyOptional({
    description: 'Notiz (z. B. „Wechselgeld aus der Vereinskasse“)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    enum: ['device', 'register'],
    description:
      'Nur an Geräten: Kassensturz für die Schublade dieses Geräts (Standard) oder die ganze Kasse',
  })
  @IsOptional()
  @IsIn(['device', 'register'])
  scope?: 'device' | 'register';
}

export class CashbookQueryDto {
  @ApiPropertyOptional({
    description: 'Geschäftstag (YYYY-MM-DD), Standard = heute',
  })
  @IsOptional()
  @Matches(DATE)
  date?: string;

  @ApiPropertyOptional({ description: 'Nur dieses Gerät', format: 'uuid' })
  @IsOptional()
  @IsString()
  deviceId?: string;
}
