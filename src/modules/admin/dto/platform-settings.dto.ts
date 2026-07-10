import { IsBoolean, IsEmail, IsObject, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class NotifyOnSettingsDto {
  @ApiPropertyOptional({ example: true, description: 'Benachrichtigung bei neuer Benutzerregistrierung' })
  @IsOptional()
  @IsBoolean()
  userRegistered?: boolean;

  @ApiPropertyOptional({ example: true, description: 'Benachrichtigung bei neuer Organisation' })
  @IsOptional()
  @IsBoolean()
  organizationCreated?: boolean;

  @ApiPropertyOptional({ example: true, description: 'Benachrichtigung bei Veranstaltungsbestellung auf Rechnung' })
  @IsOptional()
  @IsBoolean()
  eventOrdered?: boolean;
}

export class UpdateNotificationSettingsDto {
  @ApiPropertyOptional({
    example: 'admin@openeos.de',
    description: 'Ziel-E-Mail-Adresse für Benachrichtigungen. `null`, um auf die Server-Konfiguration zurückzufallen.',
    nullable: true,
  })
  @IsOptional()
  @IsEmail()
  email?: string | null;

  @ApiPropertyOptional({ description: 'Welche Ereignisse eine Benachrichtigung auslösen' })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => NotifyOnSettingsDto)
  notifyOn?: NotifyOnSettingsDto;
}
