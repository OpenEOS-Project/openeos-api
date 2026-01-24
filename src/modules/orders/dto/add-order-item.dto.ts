import {
  IsString,
  IsOptional,
  IsUUID,
  IsArray,
  MaxLength,
  IsNumber,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AddOrderItemDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'ID des Produkts' })
  @IsUUID()
  productId: string;

  @ApiProperty({ example: 2, description: 'Anzahl der bestellten Einheiten' })
  @IsNumber()
  @Min(1)
  quantity: number;

  @ApiPropertyOptional({ example: 'Ohne Zwiebeln', description: 'Allgemeine Notizen zur Position' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({ example: 'Medium gebraten', description: 'Notizen für die Küche' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  kitchenNotes?: string;

  @ApiPropertyOptional({ example: [{ group: 'Größe', option: 'Groß', priceModifier: 1.50 }], description: 'Ausgewählte Produktoptionen' })
  @IsOptional()
  @IsArray()
  selectedOptions?: { group: string; option: string; priceModifier: number }[];
}
