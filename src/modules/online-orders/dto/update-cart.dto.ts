import {
  IsUUID,
  IsNumber,
  IsOptional,
  IsString,
  IsArray,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CartItemOptionDto {
  @ApiProperty({ example: 'Größe', description: 'Name der Optionsgruppe' })
  @IsString()
  group: string;

  @ApiProperty({ example: 'Groß', description: 'Ausgewählte Option' })
  @IsString()
  option: string;

  @ApiProperty({ example: 1.50, description: 'Preismodifikator in Euro' })
  @IsNumber()
  priceModifier: number;
}

export class AddCartItemDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'ID des Produkts' })
  @IsUUID()
  productId: string;

  @ApiProperty({ example: 2, description: 'Anzahl der bestellten Einheiten' })
  @IsNumber()
  @Min(1)
  quantity: number;

  @ApiPropertyOptional({ type: [CartItemOptionDto], description: 'Ausgewählte Produktoptionen' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CartItemOptionDto)
  options?: CartItemOptionDto[];

  @ApiPropertyOptional({ example: 'Ohne Zwiebeln', description: 'Notizen zur Bestellposition' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  notes?: string;
}

export class UpdateCartItemDto {
  @ApiProperty({ example: 3, description: 'Neue Anzahl (0 zum Entfernen)' })
  @IsNumber()
  @Min(0)
  quantity: number;

  @ApiPropertyOptional({ example: 'Extra scharf', description: 'Notizen zur Bestellposition' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  notes?: string;
}
