import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  MinLength,
  MaxLength,
  Matches,
  IsOptional,
} from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'max@example.com', description: 'E-Mail-Adresse des Benutzers' })
  @IsEmail({}, { message: 'Ungültige E-Mail-Adresse' })
  email: string;

  @ApiProperty({
    example: 'SecurePass123!',
    description: 'Passwort (min. 8 Zeichen, Groß-/Kleinbuchstabe und Zahl)',
    minLength: 8,
    maxLength: 72,
  })
  @IsString()
  @MinLength(8, { message: 'Passwort muss mindestens 8 Zeichen lang sein' })
  @MaxLength(72, { message: 'Passwort darf maximal 72 Zeichen lang sein' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'Passwort muss mindestens einen Großbuchstaben, einen Kleinbuchstaben und eine Zahl enthalten',
  })
  password: string;

  @ApiProperty({ example: 'Max', description: 'Vorname des Benutzers', minLength: 2, maxLength: 100 })
  @IsString()
  @MinLength(2, { message: 'Vorname muss mindestens 2 Zeichen lang sein' })
  @MaxLength(100, { message: 'Vorname darf maximal 100 Zeichen lang sein' })
  firstName: string;

  @ApiProperty({ example: 'Mustermann', description: 'Nachname des Benutzers', minLength: 2, maxLength: 100 })
  @IsString()
  @MinLength(2, { message: 'Nachname muss mindestens 2 Zeichen lang sein' })
  @MaxLength(100, { message: 'Nachname darf maximal 100 Zeichen lang sein' })
  lastName: string;

  @ApiPropertyOptional({
    example: 'Mein Verein e.V.',
    description: 'Name der Organisation (optional, wird bei Registrierung erstellt)',
    minLength: 2,
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Organisationsname muss mindestens 2 Zeichen lang sein' })
  @MaxLength(200, { message: 'Organisationsname darf maximal 200 Zeichen lang sein' })
  organizationName?: string;
}
