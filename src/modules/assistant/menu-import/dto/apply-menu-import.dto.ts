import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PRODUCT_ICON_PATTERN } from '../../../products/dto/create-product.dto';

export class ApplyMenuCategoryDto {
  @ApiProperty({ example: 'c1', description: 'Schlüssel aus dem Vorschlag' })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  key: string;

  @ApiProperty({ example: 'Vom Grill' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({
    description:
      'Vorhandene Kategorie der Veranstaltung verwenden statt neu anzulegen',
  })
  @IsOptional()
  @IsUUID('4')
  existingCategoryId?: string;
}

export class ApplyMenuVariantDto {
  @ApiProperty({ example: '0,5 l' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: 1.5, description: 'Aufpreis zur Basis in Euro' })
  @IsNumber()
  @Min(-1000)
  @Max(1000)
  priceModifier: number;
}

export class ApplyMenuProductDto {
  @ApiProperty({ example: 'p1' })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  key: string;

  @ApiProperty({
    example: 'c1',
    description: 'Schlüssel der Kategorie aus `categories`',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  categoryKey: string;

  @ApiProperty({ example: 'Currywurst mit Pommes' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ example: 6.5, description: 'Preis in Euro (ohne Pfand)' })
  @IsNumber()
  @Min(0)
  @Max(100000)
  price: number;

  @ApiProperty({ example: 19, enum: [0, 7, 19] })
  @IsIn([0, 7, 19])
  taxRate: 0 | 7 | 19;

  @ApiPropertyOptional({ example: 'pos-icon:currywurst-pommes' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(PRODUCT_ICON_PATTERN, { message: 'Ungültiges Icon' })
  icon?: string;

  @ApiPropertyOptional({ description: 'Pfand-Typ der Organisation' })
  @IsOptional()
  @IsUUID('4')
  pfandTypeId?: string | null;

  @ApiPropertyOptional({ type: [ApplyMenuVariantDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ApplyMenuVariantDto)
  variants?: ApplyMenuVariantDto[];

  @ApiProperty({ enum: ['create', 'update', 'skip'] })
  @IsIn(['create', 'update', 'skip'])
  action: 'create' | 'update' | 'skip';

  @ApiPropertyOptional({
    description: 'Bei `update`: Produkt, das aktualisiert wird',
  })
  @IsOptional()
  @IsUUID('4')
  existingProductId?: string;
}

export class ApplyMenuImportDto {
  @ApiProperty({ type: [ApplyMenuCategoryDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ApplyMenuCategoryDto)
  categories: ApplyMenuCategoryDto[];

  @ApiProperty({ type: [ApplyMenuProductDto] })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ApplyMenuProductDto)
  products: ApplyMenuProductDto[];
}
