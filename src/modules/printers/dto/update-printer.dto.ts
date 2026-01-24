import {
  IsString,
  IsOptional,
  IsBoolean,
  MaxLength,
  IsObject,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import type { PrinterConnectionConfig } from '../../../database/entities/printer.entity';

export class UpdatePrinterDto {
  @ApiPropertyOptional({ example: 'Küchendrucker', description: 'Name des Druckers' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ example: { host: '192.168.1.100', port: 9100 }, description: 'Verbindungskonfiguration' })
  @IsOptional()
  @IsObject()
  connectionConfig?: PrinterConnectionConfig;

  @ApiPropertyOptional({ example: 'agent-kitchen-01', description: 'ID des Drucker-Agenten' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  agentId?: string;

  @ApiPropertyOptional({ example: true, description: 'Gibt an, ob der Drucker aktiv ist' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
