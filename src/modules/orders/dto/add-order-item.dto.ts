import {
  IsString,
  IsOptional,
  IsArray,
  ValidateNested,
  MaxLength,
  IsNumber,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SelectedOptionDto } from './create-order.dto';
import { IsUUIDLoose } from '../../../common/validators/is-uuid-loose.validator';

export class AddOrderItemDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'ID des Produkts' })
  @IsUUIDLoose()
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

  @ApiPropertyOptional({ type: [SelectedOptionDto], description: 'Ausgewählte Produktoptionen' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SelectedOptionDto)
  selectedOptions?: SelectedOptionDto[];
}
