import {
  IsOptional,
  IsUUID,
  IsEnum,
  IsDateString,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, PaymentTransactionStatus } from '../../../database/entities/payment.entity';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class QueryPaymentsDto extends PaginationDto {
  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'Filter nach Bestellungs-ID' })
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiPropertyOptional({ example: 'cash', description: 'Filter nach Zahlungsmethode', enum: PaymentMethod })
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @ApiPropertyOptional({ example: 'completed', description: 'Filter nach Transaktionsstatus', enum: PaymentTransactionStatus })
  @IsOptional()
  @IsEnum(PaymentTransactionStatus)
  status?: PaymentTransactionStatus;

  @ApiPropertyOptional({ example: '2024-01-01T00:00:00.000Z', description: 'Startdatum für Filterung' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2024-12-31T23:59:59.000Z', description: 'Enddatum für Filterung' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
