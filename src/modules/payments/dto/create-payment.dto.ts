import {
  IsUUID,
  IsNumber,
  IsEnum,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '../../../database/entities/payment.entity';

export class CreatePaymentDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'ID der Bestellung' })
  @IsUUID()
  orderId: string;

  @ApiProperty({ example: 25.50, description: 'Zahlungsbetrag in Euro' })
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiProperty({ example: 'cash', description: 'Zahlungsmethode', enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;

  @ApiPropertyOptional({ example: 'pi_1234567890', description: 'Transaktions-ID des Zahlungsanbieters' })
  @IsOptional()
  @IsString()
  providerTransactionId?: string;

  @ApiPropertyOptional({ example: { terminalId: 'T001', receiptNumber: '12345' }, description: 'Zusätzliche Metadaten' })
  @IsOptional()
  metadata?: Record<string, unknown>;
}
