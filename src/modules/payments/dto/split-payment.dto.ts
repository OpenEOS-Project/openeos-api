import {
  ArrayMaxSize,
  ArrayMinSize,
  IsUUID,
  IsInt,
  IsNumber,
  IsIn,
  IsArray,
  ValidateNested,
  Max,
  Min,
  IsOptional,
  IsString,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '../../../database/entities/payment.entity';
import { DIRECT_PAYMENT_METHODS } from './create-payment.dto';
import { IsUUIDLoose } from '../../../common/validators/is-uuid-loose.validator';

/** Hoechstzahl Positionen je Teilzahlung. */
export const SPLIT_MAX_LINES = 200;
/** Hoechstmenge je Position und Teilzahlung. */
export const SPLIT_MAX_QUANTITY = 10_000;
/** Obergrenze fuer Betraege in Euro (Plausibilitaet). */
export const SPLIT_MAX_AMOUNT = 1_000_000;

export class SplitPaymentItemDto {
  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'ID der Bestellposition',
  })
  @IsUUID()
  orderItemId: string;

  @ApiProperty({
    example: 2,
    description: 'Anzahl der zu bezahlenden Einheiten',
  })
  @IsInt()
  @Min(1)
  @Max(SPLIT_MAX_QUANTITY)
  quantity: number;
}

export class SplitPaymentDto {
  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'ID der Bestellung',
  })
  @IsUUID()
  orderId: string;

  @ApiProperty({
    example: 15.0,
    description:
      'Zahlungsbetrag in Euro, gleich der Summe der Positionen; höchstens der offene Betrag',
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(SPLIT_MAX_AMOUNT)
  amount: number;

  @ApiProperty({
    example: 'card',
    description:
      'Zahlungsmethode (Wertmarken nur über die Kasse: `POST /device-api/payments/batch` bzw. Bestellung mit Zahlung)',
    enum: DIRECT_PAYMENT_METHODS,
  })
  @IsIn(DIRECT_PAYMENT_METHODS)
  paymentMethod: PaymentMethod;

  @ApiProperty({
    type: [SplitPaymentItemDto],
    description: 'Liste der zu bezahlenden Positionen',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SPLIT_MAX_LINES)
  @ValidateNested({ each: true })
  @Type(() => SplitPaymentItemDto)
  items: SplitPaymentItemDto[];

  @ApiPropertyOptional({
    example: 'pi_1234567890',
    description: 'Transaktions-ID des Zahlungsanbieters',
  })
  @IsOptional()
  @IsString()
  providerTransactionId?: string;

  @ApiPropertyOptional({
    example: { terminalId: 'T001', receiptNumber: '12345' },
    description: 'Zusätzliche Metadaten',
  })
  @IsOptional()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: 50,
    description:
      'Bei Barzahlung: vom Kunden erhaltener Betrag in Euro (für das Rückgeld auf dem Bon)',
  })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(SPLIT_MAX_AMOUNT)
  amountReceived?: number;
}

/** Position einer Teilzahlung an der Kasse. */
export class DeviceSplitPaymentItemDto {
  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'ID der Bestellposition',
  })
  @IsUUIDLoose()
  orderItemId: string;

  @ApiProperty({ example: 2, description: 'Zu bezahlende Stückzahl' })
  @IsInt()
  @Min(1)
  @Max(SPLIT_MAX_QUANTITY)
  quantity: number;
}

/** `POST /device-api/payments/split`: Teilzahlung nach Positionen. */
export class DeviceSplitPaymentDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsUUIDLoose()
  orderId: string;

  @ApiProperty({
    example: 7.5,
    description:
      'Zahlungsbetrag in Euro, gleich der Summe der Positionen; höchstens der offene Betrag',
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(SPLIT_MAX_AMOUNT)
  amount: number;

  @ApiProperty({
    enum: PaymentMethod,
    example: 'cash',
    description:
      'Zahlart. Wertmarken (`tokens`) nimmt die Kasse beim Kassieren an, nicht beim Aufteilen (400 TOKEN_LINES_INVALID).',
  })
  @IsIn(Object.values(PaymentMethod))
  paymentMethod: PaymentMethod;

  @ApiProperty({ type: [DeviceSplitPaymentItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SPLIT_MAX_LINES)
  @ValidateNested({ each: true })
  @Type(() => DeviceSplitPaymentItemDto)
  items: DeviceSplitPaymentItemDto[];

  @ApiPropertyOptional({
    example: 10,
    description:
      'Bei Barzahlung: erhaltener Betrag in Euro (Rückgeld auf dem Bon)',
  })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(SPLIT_MAX_AMOUNT)
  amountReceived?: number;
}
