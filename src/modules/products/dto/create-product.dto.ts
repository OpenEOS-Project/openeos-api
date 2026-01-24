import {
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
  IsUUID,
  IsBoolean,
  IsObject,
  IsInt,
  Min,
  IsNumber,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProductDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'ID der Kategorie' })
  @IsUUID('4', { message: 'Ungültige Kategorie-ID' })
  categoryId: string;

  @ApiProperty({ example: 'Wiener Schnitzel', description: 'Name des Produkts' })
  @IsString()
  @MinLength(2, { message: 'Name muss mindestens 2 Zeichen lang sein' })
  @MaxLength(255, { message: 'Name darf maximal 255 Zeichen lang sein' })
  name: string;

  @ApiPropertyOptional({ example: 'Paniertes Kalbsschnitzel mit Kartoffelsalat', description: 'Beschreibung des Produkts' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 12.50, description: 'Verkaufspreis in Euro' })
  @IsNumber({}, { message: 'Preis muss eine Zahl sein' })
  @Min(0, { message: 'Preis darf nicht negativ sein' })
  price: number;

  @ApiPropertyOptional({ example: 'https://example.com/images/schnitzel.jpg', description: 'URL des Produktbilds' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @ApiPropertyOptional({ example: true, description: 'Gibt an, ob das Produkt aktiv ist' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ example: true, description: 'Gibt an, ob das Produkt verfügbar ist' })
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @ApiPropertyOptional({ example: false, description: 'Gibt an, ob der Lagerbestand verfolgt wird' })
  @IsOptional()
  @IsBoolean()
  trackInventory?: boolean;

  @ApiPropertyOptional({ example: 50, description: 'Anfänglicher Lagerbestand' })
  @IsOptional()
  @IsInt()
  @Min(0)
  stockQuantity?: number;

  @ApiPropertyOptional({ example: 'Stück', description: 'Einheit für den Lagerbestand' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  stockUnit?: string;

  @ApiPropertyOptional({ example: { sizes: ['S', 'M', 'L'], extras: ['Pommes', 'Salat'] }, description: 'Produktoptionen' })
  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;

  @ApiPropertyOptional({ example: { printToKitchen: true, copies: 1 }, description: 'Druckeinstellungen' })
  @IsOptional()
  @IsObject()
  printSettings?: Record<string, unknown>;

  @ApiPropertyOptional({ example: 1, description: 'Sortierreihenfolge' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
