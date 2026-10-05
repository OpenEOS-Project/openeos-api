import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsObject,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrganizationRole } from '../../../database/entities/user-organization.entity';
import type { OrganizationPermissions } from '../../../database/entities/user-organization.entity';

export class AddMemberDto {
  @ApiProperty({
    example: 'max.mustermann@example.com',
    description: 'E-Mail-Adresse des neuen Mitglieds',
  })
  @IsEmail({}, { message: 'Ungültige E-Mail-Adresse' })
  email: string;

  @ApiProperty({
    example: 'member',
    description: 'Rolle des Mitglieds in der Organisation',
    enum: OrganizationRole,
  })
  @IsEnum(OrganizationRole, { message: 'Ungültige Rolle' })
  role: OrganizationRole;

  @ApiPropertyOptional({
    example: { products: true, events: false },
    description: 'Modulberechtigungen (bei role=member)',
  })
  @IsOptional()
  @IsObject()
  permissions?: OrganizationPermissions;

  /* Die drei folgenden Felder legen in einer eigenstaendigen Installation
     ein neues Konto an, wenn es zu der Adresse noch keines gibt. Dort ist
     weder Selbstregistrierung noch Einladung per Mail verlaesslich moeglich —
     ohne diesen Weg bliebe eine Installation ohne Mailserver dauerhaft bei
     genau einem Benutzer. Die Passwortregeln entsprechen der Registrierung.
     Im gehosteten Betrieb werden sie ignoriert. */

  @ApiPropertyOptional({
    example: 'Max',
    description:
      'Vorname — nur beim Anlegen eines neuen Kontos (eigenständige Installation)',
    minLength: 2,
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Vorname muss mindestens 2 Zeichen lang sein' })
  @MaxLength(100, { message: 'Vorname darf maximal 100 Zeichen lang sein' })
  firstName?: string;

  @ApiPropertyOptional({
    example: 'Mustermann',
    description:
      'Nachname — nur beim Anlegen eines neuen Kontos (eigenständige Installation)',
    minLength: 2,
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Nachname muss mindestens 2 Zeichen lang sein' })
  @MaxLength(100, { message: 'Nachname darf maximal 100 Zeichen lang sein' })
  lastName?: string;

  @ApiPropertyOptional({
    example: 'SecurePass123!',
    description:
      'Startpasswort — nur beim Anlegen eines neuen Kontos (eigenständige Installation, nur Admins). ' +
      'Mindestens 8 Zeichen mit Groß- und Kleinbuchstaben sowie einer Zahl. ' +
      'Das Konto ist sofort anmeldebereit, eine Bestätigungsmail entfällt. ' +
      'Existiert zu der Adresse bereits ein Konto, wird die Anfrage mit USER_EXISTS abgelehnt.',
    minLength: 8,
    maxLength: 72,
  })
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'Passwort muss mindestens 8 Zeichen lang sein' })
  @MaxLength(72, { message: 'Passwort darf maximal 72 Zeichen lang sein' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message:
      'Passwort muss mindestens einen Großbuchstaben, einen Kleinbuchstaben und eine Zahl enthalten',
  })
  password?: string;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({
    example: 'admin',
    description: 'Rolle des Mitglieds in der Organisation',
    enum: OrganizationRole,
  })
  @IsOptional()
  @IsEnum(OrganizationRole, { message: 'Ungültige Rolle' })
  role?: OrganizationRole;

  @ApiPropertyOptional({
    example: { products: true, events: true },
    description: 'Modulberechtigungen (bei role=member)',
  })
  @IsOptional()
  @IsObject()
  permissions?: OrganizationPermissions;
}
