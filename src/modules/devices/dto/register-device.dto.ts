import { IsString, IsNotEmpty, IsOptional, MaxLength, IsEnum, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeviceType } from '../../../database/entities/device.entity';

export class RegisterDeviceDto {
  @ApiProperty({
    description: 'Name des Geräts',
    example: 'Kasse 1',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiProperty({
    description: 'Organisation-Slug',
    example: 'mein-verein',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  organizationSlug: string;

  @ApiPropertyOptional({
    description: 'User-Agent des Geräts',
    example: 'Mozilla/5.0 (iPad; CPU OS 14_0 like Mac OS X)',
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  userAgent?: string;
}

export class VerifyDeviceDto {
  @ApiProperty({
    description: '6-stelliger Verifizierungscode',
    example: '123456',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(6)
  code: string;
}

// New DTO for TV device initialization (no organization required)
export class InitDeviceDto {
  @ApiPropertyOptional({
    description: 'Vorgeschlagener Name des Geräts (optional)',
    example: 'FireTV Wohnzimmer',
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  suggestedName?: string;

  @ApiPropertyOptional({
    description: 'User-Agent des Geräts',
    example: 'Amazon FireTV',
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  userAgent?: string;

  @ApiPropertyOptional({
    description: 'Gewünschter Gerätetyp',
    example: 'display_menu',
    enum: DeviceType,
  })
  @IsEnum(DeviceType)
  @IsOptional()
  deviceType?: DeviceType;
}

// DTO for linking a device to an organization
export class LinkDeviceDto {
  @ApiProperty({
    description: '6-stelliger Verifizierungscode',
    example: '123456',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(6)
  code: string;

  @ApiProperty({
    description: 'Organisation-ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID()
  @IsNotEmpty()
  organizationId: string;

  @ApiPropertyOptional({
    description: 'Name für das Gerät',
    example: 'Küchen-Display',
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    description: 'Gerätetyp',
    example: 'display_kitchen',
    enum: DeviceType,
  })
  @IsEnum(DeviceType)
  @IsOptional()
  deviceType?: DeviceType;
}

// DTO for finding device by code (public lookup)
export class FindDeviceByCodeDto {
  @ApiProperty({
    description: '6-stelliger Verifizierungscode',
    example: '123456',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(6)
  code: string;
}
