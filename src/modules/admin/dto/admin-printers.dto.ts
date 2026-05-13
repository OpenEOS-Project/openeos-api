import {
  IsString,
  IsUUID,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsInt,
  Min,
  IsObject,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PrinterType, PrinterConnectionType } from '../../../database/entities/printer.entity';

export class AssignPrinterDeviceDto {
  @ApiProperty({ description: 'ID of the unassigned printer-agent device to assign' })
  @IsUUID()
  deviceId: string;

  @ApiProperty({ description: 'Target organization' })
  @IsUUID()
  organizationId: string;

  @ApiProperty({ description: 'Display name for the printer' })
  @IsString()
  name: string;

  @ApiProperty({ enum: PrinterType, description: 'Printer type' })
  @IsEnum(PrinterType)
  type: PrinterType;

  @ApiProperty({ enum: PrinterConnectionType, description: 'How the agent reaches the printer' })
  @IsEnum(PrinterConnectionType)
  connectionType: PrinterConnectionType;

  @ApiPropertyOptional({ description: 'Connection config (IP/port for network, USB ids, ...)' })
  @IsOptional()
  @IsObject()
  connectionConfig?: Record<string, unknown>;

  @ApiPropertyOptional({ default: 80 })
  @IsOptional()
  @IsInt()
  @Min(48)
  paperWidth?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  hasCashDrawer?: boolean;
}
