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
  IsInt,
  ValidateIf,
  IsIn,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { COUNTRY_CODES } from '../../../common/constants/countries';

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
    example: 14,
    nullable: true,
    description:
      'Zahlungsziel für Rechnungen (Kauf auf Rechnung über Stripe) in Tagen; leer = Standard der Plattform',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(120)
  invoiceDaysUntilDue?: number | null;

  @ApiPropertyOptional({
    example: false,
    description:
      'Priorisierter Support-Chat (unabhängig von der automatischen Regel für zahlende Organisationen)',
  })
  @IsOptional()
  @IsBoolean()
  prioritySupport?: boolean;

  @ApiPropertyOptional({
    example: 25,
    nullable: true,
    description:
      'Eigene Höchstzahl an Mitgliedern (aktive plus offene Einladungen); leer = Standard (MEMBERS_PER_ORGANIZATION_LIMIT), 0 = unbegrenzt',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(100000)
  memberLimit?: number | null;
}

export class UpdateUserAdminDto {
  @ApiPropertyOptional({
    example: 10,
    nullable: true,
    description:
      'Eigene Höchstzahl an Organisationen (Mitgliedschaften); leer = Standard (ORGANIZATIONS_PER_USER_LIMIT), 0 = unbegrenzt',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(100000)
  organizationLimit?: number | null;
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

/**
 * Betriebsmodus einer Organisation umschalten (nur Support). Der Grund ist
 * Pflicht: er steht im Verlauf, im Admin-Protokoll und auf der
 * Herstellerbescheinigung der Organisation.
 */
export class SetOperatingModeDto {
  @ApiProperty({ enum: ['pos', 'order_only'], example: 'order_only' })
  @IsIn(['pos', 'order_only'])
  mode: 'pos' | 'order_only';

  @ApiProperty({
    example: 'Antrag des Vereins per E-Mail vom 01.11.2026',
    description:
      'Anlass der Umschaltung (erscheint auf der Bescheinigung der Organisation)',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

/** Land einer Organisation aendern (nur Support, Grund ist Pflicht). */
export class SetOrganizationCountryAdminDto {
  @ApiProperty({ example: 'AT', description: 'ISO 3166-1 alpha-2' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(COUNTRY_CODES, { message: 'Bitte wähle ein Land aus der Liste.' })
  country: string;

  @ApiProperty({
    example: 'Verein sitzt in Österreich, Antrag per E-Mail vom 01.11.2026',
    description: 'Anlass (Verlauf, Admin-Protokoll, Bescheinigung)',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

/**
 * Bestandsschutz der Bargeld-Regel setzen oder aufheben (nur Support).
 * `legacy: true` ist der Weg zurueck nach dem freiwilligen Wechsel.
 */
export class SetCashPolicyAdminDto {
  @ApiProperty({
    example: true,
    description:
      'true: Bestandsschutz (Bargeld wie bisher), false: Regel des Landes',
  })
  @IsBoolean()
  legacy: boolean;

  @ApiProperty({ example: 'Wechsel versehentlich, Antrag vom 01.11.2026' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}
