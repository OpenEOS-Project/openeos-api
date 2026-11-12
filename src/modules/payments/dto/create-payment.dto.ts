import {
  IsUUID,
  IsNumber,
  IsIn,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '../../../database/entities/payment.entity';

/**
 * Zahlarten fuer Einzel-/Splitzahlungen (ohne Wertmarken). PayPal gibt es
 * nur noch in Altdaten (Anbindung in 1.8 entfernt), neu buchbar ist es nicht.
 */
export const DIRECT_PAYMENT_METHODS = Object.values(PaymentMethod).filter(
  (m) => m !== PaymentMethod.TOKENS && m !== PaymentMethod.PAYPAL,
);

export class CreatePaymentDto {
  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'ID der Bestellung',
  })
  @IsUUID()
  orderId: string;

  @ApiProperty({ example: 25.5, description: 'Zahlungsbetrag in Euro' })
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiProperty({
    example: 'cash',
    description:
      'Zahlungsmethode (Wertmarken nur über die Kasse: `POST /device-api/payments/batch` bzw. Bestellung mit Zahlung)',
    enum: DIRECT_PAYMENT_METHODS,
  })
  @IsIn(DIRECT_PAYMENT_METHODS)
  paymentMethod: PaymentMethod;

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
  @IsNumber()
  @Min(0)
  amountReceived?: number;
}
