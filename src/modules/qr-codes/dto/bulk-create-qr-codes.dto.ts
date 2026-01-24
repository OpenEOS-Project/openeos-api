import {
  IsNumber,
  IsOptional,
  IsUUID,
  IsEnum,
  Min,
  Max,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { QrCodeType } from '../../../database/entities/qr-code.entity';

export class BulkCreateQrCodesDto {
  @ApiProperty({ example: 10, description: 'Anzahl der zu erstellenden QR-Codes' })
  @IsNumber()
  @Min(1)
  @Max(100)
  count: number;

  @ApiProperty({ example: 'table', description: 'Typ der QR-Codes', enum: QrCodeType })
  @IsEnum(QrCodeType)
  type: QrCodeType;

  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'ID des zugehörigen Events' })
  @IsOptional()
  @IsUUID()
  eventId?: string;

  @ApiPropertyOptional({ example: 'Tisch-', description: 'Präfix für die Benennung' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  prefix?: string;

  @ApiPropertyOptional({ example: 1, description: 'Startnummer für die Nummerierung' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  startNumber?: number;
}
