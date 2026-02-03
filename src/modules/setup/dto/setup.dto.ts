import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  IsEnum,
  IsOptional,
  MinLength,
  MaxLength,
  Matches,
  ValidateIf,
} from 'class-validator';

export enum SetupMode {
  SINGLE = 'single',
  MULTI = 'multi',
}

export class SetupDto {
  @ApiProperty({
    enum: SetupMode,
    example: SetupMode.SINGLE,
    description: 'Installationsmodus: "single" für Einzelbetrieb, "multi" für Multi-Mandanten (SaaS)',
  })
  @IsEnum(SetupMode, { message: 'Modus muss "single" oder "multi" sein' })
  mode: SetupMode;

  @ApiProperty({ example: 'admin@example.com', description: 'E-Mail-Adresse des Admins' })
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

  @ApiProperty({ example: 'Max', description: 'Vorname des Admins', minLength: 2, maxLength: 100 })
  @IsString()
  @MinLength(2, { message: 'Vorname muss mindestens 2 Zeichen lang sein' })
  @MaxLength(100, { message: 'Vorname darf maximal 100 Zeichen lang sein' })
  firstName: string;

  @ApiProperty({ example: 'Mustermann', description: 'Nachname des Admins', minLength: 2, maxLength: 100 })
  @IsString()
  @MinLength(2, { message: 'Nachname muss mindestens 2 Zeichen lang sein' })
  @MaxLength(100, { message: 'Nachname darf maximal 100 Zeichen lang sein' })
  lastName: string;

  @ApiPropertyOptional({
    example: 'Mein Verein e.V.',
    description: 'Name der Organisation (nur bei mode="single" erforderlich)',
    minLength: 2,
    maxLength: 200,
  })
  @ValidateIf((o) => o.mode === SetupMode.SINGLE)
  @IsString({ message: 'Organisationsname ist bei Single-Modus erforderlich' })
  @MinLength(2, { message: 'Organisationsname muss mindestens 2 Zeichen lang sein' })
  @MaxLength(200, { message: 'Organisationsname darf maximal 200 Zeichen lang sein' })
  organizationName?: string;
}
