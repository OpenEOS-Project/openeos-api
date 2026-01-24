import {
  IsUUID,
  IsOptional,
  IsArray,
  IsBoolean,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CopyProductsDto {
  @ApiPropertyOptional({
    example: ['550e8400-e29b-41d4-a716-446655440000'],
    description: 'IDs der zu kopierenden Kategorien. Wenn leer, werden alle Kategorien kopiert.'
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true, message: 'Ungültige Kategorie-ID' })
  categoryIds?: string[];

  @ApiPropertyOptional({
    example: ['550e8400-e29b-41d4-a716-446655440001'],
    description: 'IDs der zu kopierenden Produkte. Wenn leer und categoryIds leer, werden alle Produkte kopiert.'
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true, message: 'Ungültige Produkt-ID' })
  productIds?: string[];

  @ApiPropertyOptional({
    example: false,
    description: 'Wenn true, wird auch der Bestand kopiert. Standard: false (Bestand wird auf 0 gesetzt)'
  })
  @IsOptional()
  @IsBoolean()
  copyStock?: boolean;
}
