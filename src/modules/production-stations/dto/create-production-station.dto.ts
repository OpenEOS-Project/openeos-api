import {
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
  IsUUID,
  IsBoolean,
  IsInt,
  Min,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProductionStationDto {
  @ApiProperty({ example: 'Küche', description: 'Name des Produktionsstandorts' })
  @IsString()
  @MinLength(2, { message: 'Name muss mindestens 2 Zeichen lang sein' })
  @MaxLength(255, { message: 'Name darf maximal 255 Zeichen lang sein' })
  name: string;

  @ApiPropertyOptional({ example: 'Hauptküche für warme Speisen', description: 'Beschreibung' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: '#FF5733', description: 'Farbcode (Hex-Format)' })
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'Ungültiges Farbformat (z.B. #FF5733)' })
  color?: string;

  @ApiPropertyOptional({ example: 0, description: 'Sortierreihenfolge' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({ example: true, description: 'Gibt an, ob der Standort aktiv ist' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'ID des zugewiesenen Druckers' })
  @IsOptional()
  @IsUUID('4', { message: 'Ungültige Drucker-ID' })
  printerId?: string | null;
}
