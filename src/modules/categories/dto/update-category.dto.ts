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
  Matches,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateCategoryDto {
  @ApiPropertyOptional({ example: 'Hauptgerichte', description: 'Name der Kategorie' })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Name muss mindestens 2 Zeichen lang sein' })
  @MaxLength(255, { message: 'Name darf maximal 255 Zeichen lang sein' })
  name?: string;

  @ApiPropertyOptional({ example: 'Warme Hauptspeisen und Gerichte', description: 'Beschreibung der Kategorie' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'ID der übergeordneten Kategorie' })
  @IsOptional()
  @IsUUID('4', { message: 'Ungültige Parent-Kategorie-ID' })
  parentId?: string | null;

  @ApiPropertyOptional({ example: '#FF5733', description: 'Farbcode der Kategorie (Hex-Format)' })
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'Ungültiges Farbformat (z.B. #FF5733)' })
  color?: string | null;

  @ApiPropertyOptional({ example: 'restaurant', description: 'Icon-Name für die Kategorie' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string | null;

  @ApiPropertyOptional({ example: 1, description: 'Sortierreihenfolge' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({ example: true, description: 'Gibt an, ob die Kategorie aktiv ist' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ example: { printToKitchen: true, printerIds: [] }, description: 'Druckeinstellungen für die Kategorie' })
  @IsOptional()
  @IsObject()
  printSettings?: Record<string, unknown> | null;
}

export class ReorderCategoriesDto {
  @ApiPropertyOptional({ example: ['550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440001'], description: 'Sortierte Liste der Kategorie-IDs' })
  @IsUUID('4', { each: true })
  categoryIds: string[];
}
