import {
  IsString,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsInt,
  MaxLength,
  IsIn,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PrinterType } from '../../../database/entities/printer.entity';

export class UpdateNetworkConnectionConfigDto {
  @ApiPropertyOptional({ example: '192.168.1.100', description: 'IP-Adresse' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  ipAddress?: string;

  @ApiPropertyOptional({ example: 9100, description: 'TCP-Port' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;
}

export class UpdatePrinterDto {
  @ApiPropertyOptional({
    example: 'Küchendrucker',
    description: 'Name des Druckers',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    example: 'kitchen',
    description: 'Druckertyp',
    enum: PrinterType,
  })
  @IsOptional()
  @IsEnum(PrinterType)
  type?: PrinterType;

  @ApiPropertyOptional({
    example: { ipAddress: '192.168.1.100', port: 9100 },
    description:
      'Netzwerkverbindung — nur bei Druckern mit connectionType `network`',
    type: UpdateNetworkConnectionConfigDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateNetworkConnectionConfigDto)
  connectionConfig?: UpdateNetworkConnectionConfigDto;

  @ApiPropertyOptional({
    example: 80,
    description: 'Papierbreite in mm (58 oder 80)',
  })
  @IsOptional()
  @IsInt()
  @IsIn([58, 80])
  paperWidth?: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Gibt an, ob der Drucker aktiv ist',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: 'Ob eine Kassenschublade angeschlossen ist',
  })
  @IsOptional()
  @IsBoolean()
  hasCashDrawer?: boolean;
}
