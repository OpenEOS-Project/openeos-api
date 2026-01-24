import {
  IsUUID,
  IsNumber,
  IsEnum,
  IsArray,
  ValidateNested,
  Min,
  IsOptional,
  IsString,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '../../../database/entities/payment.entity';

export class SplitPaymentItemDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'ID der Bestellposition' })
  @IsUUID()
  orderItemId: string;

  @ApiProperty({ example: 2, description: 'Anzahl der zu bezahlenden Einheiten' })
  @IsNumber()
  @Min(1)
  quantity: number;
}

export class SplitPaymentDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'ID der Bestellung' })
  @IsUUID()
  orderId: string;

  @ApiProperty({ example: 15.00, description: 'Zahlungsbetrag in Euro' })
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiProperty({ example: 'card', description: 'Zahlungsmethode', enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;

  @ApiProperty({ type: [SplitPaymentItemDto], description: 'Liste der zu bezahlenden Positionen' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SplitPaymentItemDto)
  items: SplitPaymentItemDto[];

  @ApiPropertyOptional({ example: 'pi_1234567890', description: 'Transaktions-ID des Zahlungsanbieters' })
  @IsOptional()
  @IsString()
  providerTransactionId?: string;

  @ApiPropertyOptional({ example: { terminalId: 'T001', receiptNumber: '12345' }, description: 'Zusätzliche Metadaten' })
  @IsOptional()
  metadata?: Record<string, unknown>;
}
