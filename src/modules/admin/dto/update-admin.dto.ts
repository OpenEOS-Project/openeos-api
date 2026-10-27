import {
  IsString,
  IsNumber,
  IsOptional,
  IsEnum,
  IsDateString,
  IsBoolean,
  Min,
  Max,
  MaxLength,
  IsObject,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SetDiscountDto {
  @ApiProperty({ example: 15, description: 'Rabattprozentsatz (0-100)' })
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPercent: number;

  @ApiPropertyOptional({
    example: '2024-12-31T23:59:59.000Z',
    description: 'Gültigkeitsdatum des Rabatts',
  })
  @IsOptional()
  @IsDateString()
  validUntil?: string;

  @ApiPropertyOptional({
    example: 'Treuebonus für langjährigen Kunden',
    description: 'Grund für den Rabatt',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class AccessOrganizationDto {
  @ApiProperty({
    example: '123456',
    description: 'Support-PIN für den Zugriff auf die Organisation',
  })
  @IsString()
  @MaxLength(10)
  supportPin: string;
}

export class UpdateOrganizationAdminDto {
  @ApiPropertyOptional({
    example: 'Musterverein e.V.',
    description: 'Name der Organisation',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Gibt an, ob die Organisation aktiv ist',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    example: { maxDevices: 5, maxUsers: 10 },
    description: 'Zusätzliche Einstellungen',
  })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: 'invoice',
    enum: ['prepaid', 'invoice'],
    description: 'Abrechnungsmodus für Event-Freischaltungen',
  })
  @IsOptional()
  @IsEnum(['prepaid', 'invoice'])
  billingMode?: 'prepaid' | 'invoice';

  @ApiPropertyOptional({
    example: 20,
    description:
      'Individueller Event-Preis in Euro (überschreibt den Standardpreis)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  eventPriceOverride?: number;

  @ApiPropertyOptional({
    example: false,
    description:
      'Priorisierter Support-Chat (unabhängig von der automatischen Regel für zahlende Organisationen)',
  })
  @IsOptional()
  @IsBoolean()
  prioritySupport?: boolean;
}

// === Subscription Config DTOs ===

export class CreateSubscriptionConfigDto {
  @ApiProperty({ example: 'Pro Plan', description: 'Name des Abo-Plans' })
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    example: 'Unser beliebtester Plan für Vereine',
    description: 'Beschreibung des Plans',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ example: 29.99, description: 'Monatlicher Preis in Euro' })
  @IsNumber()
  @Min(0)
  priceMonthly: number;

  @ApiProperty({ example: 50, description: 'Anzahl der Credits pro Monat' })
  @IsNumber()
  @Min(0)
  creditsPerMonth: number;

  @ApiPropertyOptional({ example: true, description: 'Ob der Plan aktiv ist' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    example: { maxEvents: 10, maxUsers: 20 },
    description: 'Features des Plans',
  })
  @IsOptional()
  @IsObject()
  features?: Record<string, unknown>;
}

export class UpdateSubscriptionConfigDto {
  @ApiPropertyOptional({
    example: 'Pro Plan',
    description: 'Name des Abo-Plans',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    example: 'Unser beliebtester Plan für Vereine',
    description: 'Beschreibung des Plans',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    example: 29.99,
    description: 'Monatlicher Preis in Euro',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  priceMonthly?: number;

  @ApiPropertyOptional({
    example: 50,
    description: 'Anzahl der Credits pro Monat',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  creditsPerMonth?: number;

  @ApiPropertyOptional({ example: true, description: 'Ob der Plan aktiv ist' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    example: { maxEvents: 10, maxUsers: 20 },
    description: 'Features des Plans',
  })
  @IsOptional()
  @IsObject()
  features?: Record<string, unknown>;
}
