import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsUUIDLoose } from '../../../common/validators/is-uuid-loose.validator';
import {
  TOKEN_KINDS,
  type TokenKind,
} from '../../../database/entities/token-type.entity';

export class CreateTokenTypeDto {
  @ApiProperty({ example: '2-€-Marke' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiProperty({
    example: 2,
    description: 'Nennwert in Euro (Verkaufspreis = Einlösewert)',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(1000)
  value: number;

  @ApiPropertyOptional({
    enum: TOKEN_KINDS,
    default: 'multi_purpose',
    description:
      '`multi_purpose` = Mehrzweckgutschein (Standard, § 3 Abs. 15 UStG: Steuer bei Einlösung); `single_purpose` = Einzweckgutschein (§ 3 Abs. 14 UStG: nur für Artikel mit genau einem Steuersatz, Steuer beim Verkauf).',
  })
  @IsOptional()
  @IsIn(TOKEN_KINDS)
  kind?: TokenKind;

  @ApiPropertyOptional({
    example: 19,
    description:
      'Nur Einzweckgutschein: der eine Steuersatz, für den die Marke gilt.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  vatRate?: number | null;

  @ApiPropertyOptional({
    description:
      'Nur für diese Veranstaltung (leer = alle). Pflicht, wenn Kategorien oder Artikel ausgewählt sind (die gehören zu einer Veranstaltung).',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUIDLoose()
  eventId?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description: 'Nur für Artikel dieser Kategorien',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUIDLoose({ each: true })
  allowedCategoryIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Nur für diese Artikel' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUIDLoose({ each: true })
  allowedProductIds?: string[];

  @ApiPropertyOptional({ example: '#f59e0b' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^#[0-9a-fA-F]{6}$/)
  color?: string | null;

  @ApiPropertyOptional({
    default: false,
    description:
      'Rücktausch gegen Bargeld an der Kasse erlauben (bewusste Aktion mit Beleg). Ein Rücktausch jederzeit ohne Bedingungen macht die Marke zur Guthabenkarte – beschreibe die Bedingungen in deiner Verfahrensdokumentation.',
  })
  @IsOptional()
  @IsBoolean()
  buybackAllowed?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;
}

export class UpdateTokenTypeDto extends PartialType(CreateTokenTypeDto) {}
