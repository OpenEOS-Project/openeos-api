import { IsString, IsOptional, IsBoolean, IsObject, IsArray, ValidateNested, IsIn, IsInt, Min, Max } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

/** Groesse einer Dashboard-Kachel im 12-Spalten-Raster. */
export class DashboardWidgetSizeDto {
  @ApiPropertyOptional({ example: 'topProducts', description: 'Widget-Kennung' })
  @IsString()
  id: string;

  @ApiPropertyOptional({ example: 6, description: 'Breite in Rasterspalten (1–12)' })
  @IsInt()
  @Min(1)
  @Max(12)
  w: number;

  @ApiPropertyOptional({ example: 2, description: 'Hoehe in Rasterzeilen (1–6)' })
  @IsInt()
  @Min(1)
  @Max(6)
  h: number;
}

export class DashboardPreferencesDto {
  @ApiPropertyOptional({
    example: ['ordersToday', 'revenueToday'],
    description: 'Aktivierte Dashboard-Widgets in Anzeigereihenfolge',
  })
  @IsArray()
  @IsString({ each: true })
  widgets: string[];

  /* Reihenfolge steht in widgets, Groesse hier — je ein Ort pro Belang.
     Fehlt ein Eintrag, greift die Standardgroesse des Widget-Typs. */
  @ApiPropertyOptional({
    type: [DashboardWidgetSizeDto],
    description: 'Kachelgroessen im Raster; ohne Eintrag gilt die Vorgabe',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DashboardWidgetSizeDto)
  sizes?: DashboardWidgetSizeDto[];
}

export class NotificationPreferencesDto {
  @ApiPropertyOptional({ example: true, description: 'E-Mail-Benachrichtigungen' })
  @IsOptional()
  @IsBoolean()
  email?: boolean;

  @ApiPropertyOptional({ example: true, description: 'Push-Benachrichtigungen' })
  @IsOptional()
  @IsBoolean()
  push?: boolean;
}

export class UpdatePreferencesDto {
  @ApiPropertyOptional({
    example: 'system',
    description: 'Theme-Einstellung',
    enum: ['light', 'dark', 'system'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['light', 'dark', 'system'])
  theme?: 'light' | 'dark' | 'system';

  @ApiPropertyOptional({
    example: 'de',
    description: 'Spracheinstellung',
    enum: ['de', 'en'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['de', 'en'])
  locale?: 'de' | 'en';

  @ApiPropertyOptional({
    example: { email: true, push: true },
    description: 'Benachrichtigungseinstellungen',
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => NotificationPreferencesDto)
  notifications?: NotificationPreferencesDto;

  @ApiPropertyOptional({
    example: { widgets: ['ordersToday', 'revenueToday'] },
    description: 'Dashboard-Konfiguration (aktivierte Widgets in Reihenfolge)',
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DashboardPreferencesDto)
  dashboard?: DashboardPreferencesDto;
}
