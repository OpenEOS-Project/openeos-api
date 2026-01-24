import {
  IsString,
  IsOptional,
  IsEnum,
  MaxLength,
  IsObject,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PrinterType,
  PrinterConnectionType,
} from '../../../database/entities/printer.entity';
import type { PrinterConnectionConfig } from '../../../database/entities/printer.entity';

export class CreatePrinterDto {
  @ApiProperty({ example: 'Küchendrucker', description: 'Name des Druckers' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: 'receipt', description: 'Druckertyp', enum: PrinterType })
  @IsEnum(PrinterType)
  type: PrinterType;

  @ApiProperty({ example: 'network', description: 'Verbindungstyp', enum: PrinterConnectionType })
  @IsEnum(PrinterConnectionType)
  connectionType: PrinterConnectionType;

  @ApiPropertyOptional({ example: { host: '192.168.1.100', port: 9100 }, description: 'Verbindungskonfiguration' })
  @IsOptional()
  @IsObject()
  connectionConfig?: PrinterConnectionConfig;

  @ApiPropertyOptional({ example: 'agent-kitchen-01', description: 'ID des Drucker-Agenten' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  agentId?: string;
}
