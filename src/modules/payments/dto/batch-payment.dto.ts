import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '../../../database/entities/payment.entity';
import { IsUUIDLoose } from '../../../common/validators/is-uuid-loose.validator';

/**
 * Zahlarten der Kasse fuer eine Sammelzahlung. `tokens`: nur mit
 * Wertmarken (`tokens` Pflicht, kein Geld offen).
 */
export const BATCH_PAYMENT_METHODS = [
  PaymentMethod.CASH,
  PaymentMethod.CARD,
  PaymentMethod.SUMUP_TERMINAL,
  PaymentMethod.TOKENS,
] as const;

/** Hoechstzahl Marken je Typ und Kassierung. */
export const TOKEN_TENDER_MAX_COUNT = 1000;

/** Vom Gast erhaltene Wertmarken eines Typs (Stueck). */
export class TokenTenderDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsUUIDLoose()
  tokenTypeId: string;

  @ApiProperty({ example: 3, description: 'Anzahl Marken dieses Typs' })
  @IsInt()
  @Min(1)
  @Max(TOKEN_TENDER_MAX_COUNT)
  count: number;
}

/**
 * Wertmarken als (Teil-)Zahlung, gemeinsam fuer Sammelzahlung und
 * Bestellung mit Zahlung.
 */
export class TokenTenderFields {
  @ApiPropertyOptional({
    type: [TokenTenderDto],
    description:
      'Vom Gast erhaltene Wertmarken (nur „Alle Funktionen“, in Deutschland nur mit aktiver Cloud-TSE). Ihr Wert deckt zuerst, was die Marken decken dürfen; den Rest kassiert `paymentMethod`. Wechselgeld in Marken gibt es nicht.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => TokenTenderDto)
  tokens?: TokenTenderDto[];

  @ApiPropertyOptional({
    example: false,
    description:
      'Sind die Marken mehr wert als offen ist, wird der Rest als Trinkgeld gebucht (der Gast verzichtet auf Wechselgeld). Ohne diese Bestätigung: 400 TOKEN_OVERPAYMENT.',
  })
  @IsOptional()
  @IsBoolean()
  tokenExcessAsTip?: boolean;
}

export type BatchPaymentMethod = (typeof BATCH_PAYMENT_METHODS)[number];

export const BATCH_MAX_ORDERS = 50;

/**
 * Mehrere offene Bestellungen (z. B. alle eines Tisches) in einer
 * Transaktion kassieren (Spezifikation §3.4, §5.2.3).
 */
export class BatchPaymentDto extends TokenTenderFields {
  @ApiProperty({
    type: [String],
    description:
      'Zu kassierende Bestellungen (1–50). Reihenfolge zählt: Trinkgeld und das erhaltene Bargeld landen auf der letzten, Rabatt wird von hinten verteilt.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_MAX_ORDERS)
  @ArrayUnique()
  @IsUUIDLoose({ each: true })
  orderIds: string[];

  @ApiProperty({ enum: BATCH_PAYMENT_METHODS, example: 'cash' })
  @IsIn(BATCH_PAYMENT_METHODS)
  paymentMethod: BatchPaymentMethod;

  @ApiPropertyOptional({
    example: 50,
    description:
      'Bei Barzahlung: insgesamt erhaltener Betrag in Euro (für Rückgeld und Bon)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amountReceived?: number;

  @ApiPropertyOptional({
    example: 2,
    description: 'Trinkgeld in Euro, wird auf die letzte Bestellung gebucht',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  tipAmount?: number;

  @ApiPropertyOptional({
    example: 'TX-12345',
    description:
      'Transaktions-ID des Zahlungsanbieters (z. B. SumUp), an jeder Zahlung gespeichert',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  providerTransactionId?: string;

  @ApiPropertyOptional({
    example: { terminalId: 'T001' },
    description: 'Zusätzliche Metadaten, an jeder Zahlung gespeichert',
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: 4.5,
    description:
      'Rabatt (Rabatt-Bons) in Euro auf bereits angelegte Bestellungen; von der letzten Bestellung rückwärts verteilt, je Bestellung auf ihren offenen Betrag ohne Pfand gedeckelt',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discountAmount?: number;

  @ApiPropertyOptional({ example: 'Freigetränk' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  discountReason?: string;
}
