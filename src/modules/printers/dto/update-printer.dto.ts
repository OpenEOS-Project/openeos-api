import {
  IsString,
  IsOptional,
  IsBoolean,
  IsUUID,
  IsInt,
  MaxLength,
  IsObject,
  IsIn,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import type { PrinterConnectionConfig } from '../../../database/entities/printer.entity';

export class UpdatePrinterDto {
  @ApiPropertyOptional({ example: 'Küchendrucker', description: 'Name des Druckers' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ example: { ipAddress: '192.168.1.100', port: 9100 }, description: 'Verbindungskonfiguration' })
  @IsOptional()
  @IsObject()
  connectionConfig?: PrinterConnectionConfig;

  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'ID des zugeordneten Printer-Agent-Geräts' })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ApiPropertyOptional({ example: 80, description: 'Papierbreite in mm (58 oder 80)' })
  @IsOptional()
  @IsInt()
  @IsIn([58, 80])
  paperWidth?: number;

  @ApiPropertyOptional({ example: true, description: 'Gibt an, ob der Drucker aktiv ist' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ example: false, description: 'Ob eine Kassenschublade angeschlossen ist' })
  @IsOptional()
  @IsBoolean()
  hasCashDrawer?: boolean;
}
