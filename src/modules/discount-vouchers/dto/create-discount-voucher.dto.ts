import {
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsBoolean,
  IsInt,
  Min,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DiscountVoucherType } from '../../../database/entities/discount-voucher.entity';

export class CreateDiscountVoucherDto {
  @ApiProperty({
    example: 'Künstler-Bon 3 €',
    description: 'Anzeigename des Rabatt-Bons',
  })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({
    example: 'Für alle Künstler auf dem Fest',
    description: 'Beschreibung',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({
    example: DiscountVoucherType.FIXED,
    enum: DiscountVoucherType,
    description:
      'Art des Bons: fester Betrag oder bei Einlösung eingegebener Betrag',
  })
  @IsEnum(DiscountVoucherType)
  type: DiscountVoucherType;

  @ApiPropertyOptional({
    example: 3.0,
    description:
      'Rabattbetrag in EUR (Pflicht bei type=fixed, ignoriert bei type=manual)',
  })
  @ValidateIf(
    (dto: CreateDiscountVoucherDto) => dto.type === DiscountVoucherType.FIXED,
  )
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount?: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Ob der Bon aktiv (an der Kasse auswählbar) ist',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: 'Ob der Bon mehrfach pro Bestellung verwendet werden darf',
  })
  @IsOptional()
  @IsBoolean()
  allowMultiplePerOrder?: boolean;

  @ApiPropertyOptional({
    example: 0,
    description: 'Sortierreihenfolge an der Kasse',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
