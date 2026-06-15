import { IsString, IsBoolean, IsOptional, IsIn, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type ProductImportMode = 'skip' | 'update' | 'create';

export class ImportProductsDto {
  @ApiProperty({ description: 'Roher CSV-Inhalt der Produktliste' })
  @IsString()
  @MaxLength(1_000_000, { message: 'CSV-Datei ist zu groß' })
  csv: string;

  @ApiPropertyOptional({
    enum: ['skip', 'update', 'create'],
    description:
      'Verhalten bei vorhandenen Produkten (gleicher Name + Kategorie): überspringen, aktualisieren oder immer neu anlegen',
    default: 'skip',
  })
  @IsOptional()
  @IsIn(['skip', 'update', 'create'])
  mode?: ProductImportMode;

  @ApiPropertyOptional({
    description: 'true = nur Vorschau berechnen, nichts speichern',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
