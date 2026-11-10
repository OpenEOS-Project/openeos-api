import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class ReceiptOrdersDto {
  @ApiProperty({
    description:
      'Bestellungen, deren Kassenbeleg ausgegeben wird (je Bestellung die letzte Zahlung, wie beim Nachdruck). 1–20.',
    type: [String],
    format: 'uuid',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  orderIds: string[];
}

export class SendReceiptEmailDto extends ReceiptOrdersDto {
  @ApiProperty({
    description:
      'E-Mail-Adresse des Gastes. Wird nur für den Versand verwendet und nicht gespeichert.',
    example: 'gast@example.org',
  })
  @IsEmail()
  @MaxLength(254)
  email: string;
}
