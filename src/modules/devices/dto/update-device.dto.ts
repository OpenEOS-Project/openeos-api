import {
  IsString,
  IsOptional,
  IsBoolean,
  MaxLength,
  IsObject,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import type { DeviceSettings } from '../../../database/entities/device.entity';

export class UpdateDeviceDto {
  @ApiPropertyOptional({ example: 'Kasse 1', description: 'Name des Geräts' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ example: true, description: 'Gibt an, ob das Gerät aktiv ist' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ example: { theme: 'dark', language: 'de' }, description: 'Geräteeinstellungen' })
  @IsOptional()
  @IsObject()
  settings?: DeviceSettings;
}
