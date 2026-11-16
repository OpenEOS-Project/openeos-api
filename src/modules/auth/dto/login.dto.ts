import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class LoginDto {
  @ApiProperty({
    example: 'max@example.com',
    description: 'E-Mail-Adresse des Benutzers',
  })
  @IsEmail({}, { message: 'Ungültige E-Mail-Adresse' })
  email: string;

  @ApiProperty({
    example: 'SecurePass123!',
    description: 'Passwort des Benutzers',
  })
  @IsString()
  @MinLength(1, { message: 'Passwort ist erforderlich' })
  password: string;

  @ApiPropertyOptional({
    deprecated: true,
    description:
      'Veraltet und ohne Wirkung. Ob der zweite Faktor entfällt, entscheidet allein das Cookie `trustedDevice` eines vertrauten Geräts.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceFingerprint?: string;
}
