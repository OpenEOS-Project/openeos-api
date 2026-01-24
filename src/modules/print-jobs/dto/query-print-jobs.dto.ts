import {
  IsOptional,
  IsUUID,
  IsEnum,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PrintJobStatus } from '../../../database/entities/print-job.entity';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class QueryPrintJobsDto extends PaginationDto {
  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'Filter nach Drucker-ID' })
  @IsOptional()
  @IsUUID()
  printerId?: string;

  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440001', description: 'Filter nach Bestellungs-ID' })
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiPropertyOptional({ example: 'pending', description: 'Filter nach Druckauftragsstatus', enum: PrintJobStatus })
  @IsOptional()
  @IsEnum(PrintJobStatus)
  status?: PrintJobStatus;
}
