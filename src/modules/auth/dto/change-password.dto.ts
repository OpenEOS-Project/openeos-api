import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';

export class ChangePasswordDto {
  /* Konten ohne Passwort (nur Anmeldelink, `hasPassword: false` in
     GET /auth/me) setzen hier ihr erstes und schicken keins mit. */
  @ApiPropertyOptional({
    example: 'OldPass123!',
    description:
      'Aktuelles Passwort. Pflicht, wenn das Konto schon eins hat (`hasPassword`); Konten ohne Passwort lassen es weg und legen ihr erstes fest.',
  })
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @ApiProperty({
    example: 'NewSecurePass123!',
    description:
      'Neues Passwort (min. 8 Zeichen, Groß-/Kleinbuchstabe und Zahl)',
    minLength: 8,
    maxLength: 72,
  })
  @IsString()
  @MinLength(8, { message: 'Passwort muss mindestens 8 Zeichen lang sein' })
  @MaxLength(72, { message: 'Passwort darf maximal 72 Zeichen lang sein' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message:
      'Passwort muss mindestens einen Großbuchstaben, einen Kleinbuchstaben und eine Zahl enthalten',
  })
  newPassword: string;
}
