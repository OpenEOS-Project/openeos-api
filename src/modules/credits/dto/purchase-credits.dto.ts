import { IsUUID, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CreditPaymentMethod } from '../../../database/entities/credit-purchase.entity';

export class PurchaseCreditsDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'ID des Credit-Pakets' })
  @IsUUID()
  packageId: string;

  @ApiProperty({ example: 'stripe', description: 'Zahlungsmethode', enum: CreditPaymentMethod })
  @IsEnum(CreditPaymentMethod)
  paymentMethod: CreditPaymentMethod;
}
