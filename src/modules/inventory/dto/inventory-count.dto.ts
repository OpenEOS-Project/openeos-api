import {
  IsString,
  IsOptional,
  IsUUID,
  IsNumber,
  IsEnum,
  IsInt,
  Min,
  Max,
  MaxLength,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InventoryCountStatus } from '../../../database/entities/inventory-count.entity';

export class CreateInventoryCountDto {
  @ApiProperty({ example: 'Monatliche Inventur Juli 2024', description: 'Name der Inventurzählung' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({ example: 'Reguläre monatliche Bestandsaufnahme', description: 'Zusätzliche Notizen' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateInventoryCountDto {
  @ApiPropertyOptional({ example: 'Monatliche Inventur Juli 2024', description: 'Name der Inventurzählung' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ example: 'Aktualisierte Notizen', description: 'Zusätzliche Notizen' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class AddInventoryItemDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'ID des Produkts' })
  @IsUUID()
  productId: string;
}

export class BulkAddInventoryItemsDto {
  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'Kategorie-ID zum Hinzufügen aller Produkte dieser Kategorie' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ example: ['550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440001'], description: 'Liste von Produkt-IDs' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  productIds?: string[];
}

export class UpdateInventoryItemDto {
  @ApiProperty({ example: 45, description: 'Gezählte Menge' })
  @IsNumber()
  @IsInt()
  @Min(0)
  countedQuantity: number;

  @ApiPropertyOptional({ example: '3 Einheiten beschädigt, aus Bestand entfernt', description: 'Notizen zur Zählung' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class QueryInventoryCountsDto {
  @ApiPropertyOptional({ example: 'draft', description: 'Filter nach Inventurstatus', enum: InventoryCountStatus })
  @IsOptional()
  @IsEnum(InventoryCountStatus)
  status?: InventoryCountStatus;

  @ApiPropertyOptional({ example: 1, description: 'Seitennummer für Pagination', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, description: 'Anzahl der Ergebnisse pro Seite', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
