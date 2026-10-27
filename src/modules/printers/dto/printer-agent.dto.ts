import {
  IsString,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsInt,
  IsIn,
  MaxLength,
  Min,
  Max,
  IsArray,
  ValidateNested,
  ArrayMaxSize,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PrinterType,
  PrinterConnectionType,
} from '../../../database/entities/printer.entity';
import {
  DISCOVERED_VIA,
  type DiscoveredVia,
} from '../../../database/entities/discovered-printer.entity';

/** Details eines gefundenen Druckers, wie der Agent sie meldet. */
export class DiscoveredPrinterDetailsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  manufacturer?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  product?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  model?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  serialNumber?: string;

  @ApiPropertyOptional({ example: '04b8' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  usbVendorId?: string;

  @ApiPropertyOptional({ example: '0202' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  usbProductId?: string;

  @ApiPropertyOptional({ example: '192.168.1.50' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  ipAddress?: string;

  @ApiPropertyOptional({ example: 9100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  hostname?: string;

  @ApiPropertyOptional({ example: 'aa:bb:cc:dd:ee:ff' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  macAddress?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  windowsPrinterName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  driverName?: string;
}

/** `DiscoveredPrinterInput` aus der Spezifikation. */
export class DiscoveredPrinterInputDto {
  @ApiProperty({ example: 'usb:04b8:0202:ABC123' })
  @IsString()
  @MaxLength(255)
  fingerprint: string;

  @ApiProperty({ enum: PrinterConnectionType })
  @IsEnum(PrinterConnectionType)
  connectionType: PrinterConnectionType;

  @ApiProperty({ example: 'EPSON TM-T88V' })
  @IsString()
  @MaxLength(255)
  displayName: string;

  @ApiPropertyOptional({ type: DiscoveredPrinterDetailsDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DiscoveredPrinterDetailsDto)
  details?: DiscoveredPrinterDetailsDto;

  @ApiProperty({ enum: DISCOVERED_VIA, example: 'usb' })
  @IsIn(DISCOVERED_VIA)
  discoveredVia: DiscoveredVia;
}

export class ReportDiscoveredPrintersDto {
  @ApiProperty({ type: [DiscoveredPrinterInputDto] })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => DiscoveredPrinterInputDto)
  printers: DiscoveredPrinterInputDto[];

  @ApiProperty({
    description:
      'true = vollständiger Scan. Nicht gemeldete Einträge bleiben erhalten, nur ihr lastSeenAt bleibt alt.',
  })
  @IsBoolean()
  full: boolean;
}

export class DiscoverPrintersDto {
  @ApiPropertyOptional({
    description: 'Auch das lokale /24 auf Port 9100 durchsuchen',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  subnetScan?: boolean;
}

export class AdoptDiscoveredPrinterDto {
  @ApiProperty({ example: 'Küchendrucker' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ enum: PrinterType, example: 'kitchen' })
  @IsEnum(PrinterType)
  type: PrinterType;

  @ApiProperty({ example: 80, description: '58 oder 80' })
  @IsInt()
  @IsIn([58, 80])
  paperWidth: number;

  @ApiProperty({ example: false })
  @IsBoolean()
  hasCashDrawer: boolean;
}
