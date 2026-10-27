import {
  IsString,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsUUID,
  IsInt,
  MaxLength,
  IsIn,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PrinterType,
  PrinterConnectionType,
} from '../../../database/entities/printer.entity';

/** Netzwerkverbindung eines manuell angelegten Druckers. */
export class NetworkConnectionConfigDto {
  @ApiProperty({ example: '192.168.1.100', description: 'IP-Adresse' })
  @IsString()
  @MaxLength(255)
  ipAddress: string;

  @ApiPropertyOptional({
    example: 9100,
    description: 'TCP-Port (Standard 9100)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;
}

/**
 * Manuell angelegter Drucker — nur `network`, fuer Geraete, die die
 * Erkennung des Agents nicht findet. USB- und Windows-Drucker entstehen
 * ausschliesslich ueber „Uebernehmen“ aus der Erkennung.
 */
export class CreatePrinterDto {
  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description:
      'Drucker-Agent (Gerät vom Typ printer_agent), an dem der Drucker hängt',
  })
  @IsUUID()
  deviceId: string;

  @ApiProperty({ example: 'Küchendrucker', description: 'Name des Druckers' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({
    example: 'receipt',
    description: 'Druckertyp',
    enum: PrinterType,
  })
  @IsEnum(PrinterType)
  type: PrinterType;

  @ApiPropertyOptional({
    example: 'network',
    description: 'Verbindungstyp — manuell ist nur `network` erlaubt',
    enum: PrinterConnectionType,
  })
  @IsOptional()
  @IsEnum(PrinterConnectionType)
  connectionType?: PrinterConnectionType;

  @ApiProperty({
    example: { ipAddress: '192.168.1.100', port: 9100 },
    description: 'Netzwerkverbindung',
    type: NetworkConnectionConfigDto,
  })
  @ValidateNested()
  @Type(() => NetworkConnectionConfigDto)
  connectionConfig: NetworkConnectionConfigDto;

  @ApiPropertyOptional({
    example: 80,
    description: 'Papierbreite in mm (58 oder 80)',
  })
  @IsOptional()
  @IsInt()
  @IsIn([58, 80])
  paperWidth?: number;

  @ApiPropertyOptional({
    example: false,
    description: 'Ob eine Kassenschublade angeschlossen ist',
  })
  @IsOptional()
  @IsBoolean()
  hasCashDrawer?: boolean;
}
