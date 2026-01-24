import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { QrCodeType } from '../../../database/entities/qr-code.entity';

export class CreateQrCodeDto {
  @ApiProperty({ example: 'table', description: 'Typ des QR-Codes', enum: QrCodeType })
  @IsEnum(QrCodeType)
  type: QrCodeType;

  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'ID des zugehörigen Events' })
  @IsOptional()
  @IsUUID()
  eventId?: string;

  @ApiPropertyOptional({ example: 'T5', description: 'Tischnummer (für Tisch-QR-Codes)' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tableNumber?: string;

  @ApiPropertyOptional({ example: 'Tisch 5 - Terrasse', description: 'Bezeichnung des QR-Codes' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;
}
