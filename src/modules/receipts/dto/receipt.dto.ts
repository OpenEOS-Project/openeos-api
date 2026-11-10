import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
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

export class IssueHospitalityReceiptDto extends ReceiptOrdersDto {
  @ApiProperty({
    required: false,
    description:
      'Name des Bewirtenden bzw. der Firma (Leistungsempfänger). Pflicht, wenn der Rechnungsbetrag über 250 € liegt.',
    example: 'Muster GmbH',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  recipientName?: string;

  @ApiProperty({
    required: false,
    description:
      'Anschrift des Leistungsempfängers (optional, für den Vorsteuerabzug über 250 €).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  recipientAddress?: string;

  @ApiProperty({
    required: false,
    description:
      'Tag der Bewirtung (JJJJ-MM-TT), Standard: Tag der Bestellung. Erlaubt: Vortag der Bestellung bis heute.',
    example: '2026-11-11',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  serviceDate?: string;
}

export class HospitalityEmailDto {
  @ApiProperty({
    description:
      'E-Mail-Adresse. Wird nur für den Versand verwendet und nicht gespeichert.',
  })
  @IsEmail()
  @MaxLength(254)
  email: string;
}
