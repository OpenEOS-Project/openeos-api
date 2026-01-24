import {
  IsUUID,
  IsOptional,
  IsObject,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { PrintJobPayload } from '../../../database/entities/print-job.entity';

export class CreatePrintJobDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'ID des Druckers' })
  @IsUUID()
  printerId: string;

  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440001', description: 'ID der Druckvorlage' })
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440002', description: 'ID der Bestellung' })
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440003', description: 'ID der Bestellposition' })
  @IsOptional()
  @IsUUID()
  orderItemId?: string;

  @ApiProperty({ example: { orderNumber: 'B-001', items: [], total: 25.50 }, description: 'Druckdaten' })
  @IsObject()
  payload: PrintJobPayload;
}
