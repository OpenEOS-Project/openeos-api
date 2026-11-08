import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsDefined,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const WITH_TSE_DESCRIPTION =
  'Nur Bestandsorganisationen in Deutschland (Bargeld ohne TSE): Antwort auf „Mit Cloud-TSE (Bargeld rechtssicher)?“. ' +
  '`true` stellt beim Freischalten auf „Alle Funktionen“ um, schaltet die Integration `tse` ein und die TSE wird automatisch angelegt; ' +
  '`false` oder fehlend: alles bleibt, wie es ist. Bei „Alle Funktionen“ in Deutschland gehört die TSE immer dazu, sonst wird der Wert ignoriert.';

export class OrderInvoiceBillingAddressDto {
  @ApiProperty({ example: 'Musterstraße 1' })
  @IsString()
  @IsNotEmpty()
  street: string;

  @ApiProperty({ example: '12345' })
  @IsString()
  @IsNotEmpty()
  zip: string;

  @ApiProperty({ example: 'Musterstadt' })
  @IsString()
  @IsNotEmpty()
  city: string;
}

export class OrderInvoiceDto {
  @ApiProperty({
    example: 'Musterverein e.V.',
    description: 'Rechnungsempfänger (Name)',
  })
  @IsString()
  @IsNotEmpty()
  billingName: string;

  @ApiProperty({ example: 'kasse@musterverein.de' })
  @IsEmail()
  billingEmail: string;

  @ApiProperty({ type: OrderInvoiceBillingAddressDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => OrderInvoiceBillingAddressDto)
  billingAddress: OrderInvoiceBillingAddressDto;

  @ApiPropertyOptional({ description: WITH_TSE_DESCRIPTION })
  @IsOptional()
  @IsBoolean()
  withTse?: boolean;
}

/** `POST …/events/:eventId/checkout` (Body optional). */
export class CreateEventCheckoutDto {
  @ApiPropertyOptional({ description: WITH_TSE_DESCRIPTION })
  @IsOptional()
  @IsBoolean()
  withTse?: boolean;
}

/** `POST /admin/events/:id/waive` (Body optional). */
export class WaiveEventDto {
  @ApiPropertyOptional({ description: WITH_TSE_DESCRIPTION })
  @IsOptional()
  @IsBoolean()
  withTse?: boolean;

  @ApiPropertyOptional({
    description:
      'Fehlen Pflichtangaben (400 `PURCHASE_MASTER_DATA_REQUIRED`), trotzdem erlassen. Nur mit `overrideReason` (protokolliert als `event_master_data_override`).',
  })
  @IsOptional()
  @IsBoolean()
  overrideMasterData?: boolean;

  @ApiPropertyOptional({ example: 'Angaben kommen per Mail nach' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  overrideReason?: string;
}

/**
 * `PUT /organizations/:organizationId/purchase-master-data`: Pflichtangaben
 * vor dem Kauf. Schreibt Steuerangaben (`settings.legalName`, `taxNumber`,
 * `vatId`), die Rechnungsanschrift und — falls noch leer — die Anschrift der
 * Organisation (Reiter „Kontakt“).
 */
export class PurchaseMasterDataDto {
  @ApiProperty({
    example: 'Musterverein e.V.',
    description: 'Offizieller Name (wie im Vereinsregister)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legalName: string;

  @ApiProperty({ example: 'Musterstraße 1' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  street: string;

  @ApiProperty({ example: '12345' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  zip: string;

  @ApiProperty({ example: 'Musterstadt' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city: string;

  @ApiPropertyOptional({
    example: '12/345/67890',
    description:
      'Steuernummer (Deutschland: 10–13 Ziffern). Leerer Text löscht sie.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  taxNumber?: string;

  @ApiPropertyOptional({
    example: 'DE123456789',
    description: 'USt-IdNr. (DE + 9 Ziffern). Leerer Text löscht sie.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  vatId?: string;
}

/**
 * `POST /admin/events/:id/dates` (Support): Beginn/Ende verschieben, obwohl
 * das Verkaufsfenster schon begonnen hat. Grund Pflicht, protokolliert als
 * `event_dates_override`; die bezahlte Dauer gilt weiter.
 */
export class MoveEventDatesDto {
  @ApiPropertyOptional({ example: '2026-11-21T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ example: '2026-11-22T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiProperty({ example: 'Fest wegen Unwetter um eine Woche verschoben' })
  @IsString()
  @MaxLength(500)
  reason: string;
}
