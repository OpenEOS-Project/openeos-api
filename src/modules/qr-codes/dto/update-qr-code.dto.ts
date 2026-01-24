import {
  IsString,
  IsOptional,
  IsBoolean,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateQrCodeDto {
  @ApiPropertyOptional({ example: 'T5', description: 'Tischnummer' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tableNumber?: string;

  @ApiPropertyOptional({ example: 'Tisch 5 - Terrasse', description: 'Bezeichnung des QR-Codes' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: true, description: 'Gibt an, ob der QR-Code aktiv ist' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
