import {
  IsString,
  IsOptional,
  IsEnum,
  MaxLength,
  IsObject,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeviceType } from '../../../database/entities/device.entity';
import type { DeviceSettings } from '../../../database/entities/device.entity';

export class CreateDeviceDto {
  @ApiProperty({ example: 'Kasse 1', description: 'Name des Geräts' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: 'pos', description: 'Gerätetyp', enum: DeviceType })
  @IsEnum(DeviceType)
  type: DeviceType;

  @ApiPropertyOptional({ example: { theme: 'dark', language: 'de' }, description: 'Geräteeinstellungen' })
  @IsOptional()
  @IsObject()
  settings?: DeviceSettings;
}
