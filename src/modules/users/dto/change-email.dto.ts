import { IsString, IsEmail, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RequestEmailChangeDto {
  @ApiProperty({
    example: 'neue-email@example.com',
    description: 'Neue E-Mail-Adresse',
  })
  @IsString()
  @IsEmail()
  @MaxLength(255)
  newEmail: string;

  @ApiPropertyOptional({
    example: 'MeinPasswort123!',
    description:
      'Aktuelles Passwort zur Bestätigung. Pflicht, wenn das Konto eins hat (`hasPassword` in GET /auth/me); Konten ohne Passwort lassen es weg.',
  })
  @IsOptional()
  @IsString()
  password?: string;
}

export class VerifyEmailChangeDto {
  @ApiProperty({
    example: 'abc123...',
    description: 'Verifizierungstoken aus der E-Mail',
  })
  @IsString()
  token: string;
}
