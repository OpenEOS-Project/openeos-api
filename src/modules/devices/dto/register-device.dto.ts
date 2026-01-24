import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
