import { Type } from 'class-transformer';
import { IsDefined, IsEmail, IsNotEmpty, IsString, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

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
  @ApiProperty({ example: 'Musterverein e.V.', description: 'Rechnungsempfänger (Name)' })
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
}
