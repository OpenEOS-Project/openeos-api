import {
  IsString,
  IsOptional,
  MaxLength,
  IsNumber,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateOrderItemDto {
  @ApiPropertyOptional({ example: 3, description: 'Neue Anzahl der bestellten Einheiten' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  quantity?: number;

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
}
