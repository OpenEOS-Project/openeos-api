import {
  IsString,
  IsOptional,
  IsEnum,
  MaxLength,
  IsNumber,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { OrderPriority } from '../../../database/entities/order.entity';

export class UpdateOrderDto {
  @ApiPropertyOptional({ example: 'T5', description: 'Tischnummer' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tableNumber?: string;

  @ApiPropertyOptional({ example: 'Max Mustermann', description: 'Name des Kunden' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  customerName?: string;

  @ApiPropertyOptional({ example: '+49 170 1234567', description: 'Telefonnummer des Kunden' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  customerPhone?: string;

  @ApiPropertyOptional({ example: 'Bitte zusammen servieren', description: 'Allgemeine Bestellnotizen' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({ example: 'high', description: 'Priorität der Bestellung', enum: OrderPriority })
  @IsOptional()
  @IsEnum(OrderPriority)
  priority?: OrderPriority;

  @ApiPropertyOptional({ example: 2.50, description: 'Trinkgeldbetrag in Euro' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tipAmount?: number;

  @ApiPropertyOptional({ example: 5.00, description: 'Rabattbetrag in Euro' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @ApiPropertyOptional({ example: 'Stammkundenrabatt', description: 'Grund für den Rabatt' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  discountReason?: string;
}
