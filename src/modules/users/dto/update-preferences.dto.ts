import { IsString, IsOptional, IsBoolean, IsObject, IsArray, ValidateNested, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class DashboardPreferencesDto {
  @ApiPropertyOptional({
    example: ['ordersToday', 'revenueToday'],
    description: 'Aktivierte Dashboard-Widgets in Anzeigereihenfolge',
  })
  @IsArray()
  @IsString({ each: true })
  widgets: string[];
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
