import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
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
}
