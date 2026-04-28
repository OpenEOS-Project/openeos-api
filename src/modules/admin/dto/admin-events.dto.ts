import { IsOptional, IsDateString, IsEnum, IsInt, Min, Max, IsString, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { EventStatus } from '../../../database/entities/event.entity';

export class QueryAdminEventsDto {
  @ApiPropertyOptional({ example: 'Sommerfest', description: 'Suchbegriff für Event-Name' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: 'active', description: 'Filter nach Event-Status', enum: EventStatus })
  @IsOptional()
  @IsEnum(EventStatus)
  status?: EventStatus;

  @ApiPropertyOptional({ example: '2024-01-01T00:00:00.000Z', description: 'Startdatum für Filterung' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2024-12-31T23:59:59.000Z', description: 'Enddatum für Filterung' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ example: true, description: 'Filter nach Abrechnung (true = abgerechnet, false = nicht abgerechnet)' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  invoiced?: boolean;

  @ApiPropertyOptional({ example: 1, description: 'Seitennummer für Pagination', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, description: 'Anzahl der Ergebnisse pro Seite', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class MarkInvoicedDto {
  @ApiProperty({ example: 'Rechnung 2024-001 erstellt', description: 'Optionale Notiz zur Abrechnung', required: false })
  @IsOptional()
  @IsString()
  note?: string;
}
