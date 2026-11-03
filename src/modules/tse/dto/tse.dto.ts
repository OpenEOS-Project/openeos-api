import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateTseDto {
  @ApiPropertyOptional({
    description:
      'Nur Super-Admins: Bedingungen (bezahlte Veranstaltung, Monat) übergehen. Braucht `reason`.',
  })
  @IsOptional()
  @IsBoolean()
  override?: boolean;

  @ApiPropertyOptional({ description: 'Begründung der Ausnahme (Protokoll)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class DeactivateTseDto {
  @ApiPropertyOptional({
    description: 'Muss `true` sein: das Deaktivieren ist endgültig.',
  })
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;

  @ApiPropertyOptional({
    description: 'Grund (Protokoll, Verfahrensdokumentation)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class QueryTseTransactionsDto {
  @ApiPropertyOptional({ enum: ['pending', 'signed', 'training', 'failed'] })
  @IsOptional()
  @IsIn(['pending', 'signed', 'training', 'failed'])
  status?: 'pending' | 'signed' | 'training' | 'failed';

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class QueryTseUsageDto {
  @ApiPropertyOptional({ description: 'Jahr (Standard: aktueller Monat)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2024)
  year?: number;

  @ApiPropertyOptional({ description: 'Monat 1–12' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;
}
