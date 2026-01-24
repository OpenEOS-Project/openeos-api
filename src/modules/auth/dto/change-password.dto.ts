import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength, MaxLength, Matches } from 'class-validator';

export class ChangePasswordDto {
  @ApiProperty({ example: 'OldPass123!', description: 'Aktuelles Passwort' })
  @IsString()
  @MinLength(1, { message: 'Aktuelles Passwort ist erforderlich' })
  currentPassword: string;

  @ApiProperty({
    example: 'NewSecurePass123!',
    description: 'Neues Passwort (min. 8 Zeichen, Groß-/Kleinbuchstabe und Zahl)',
    minLength: 8,
    maxLength: 72,
  })
  @IsString()
  @MinLength(8, { message: 'Passwort muss mindestens 8 Zeichen lang sein' })
  @MaxLength(72, { message: 'Passwort darf maximal 72 Zeichen lang sein' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'Passwort muss mindestens einen Großbuchstaben, einen Kleinbuchstaben und eine Zahl enthalten',
  })
  newPassword: string;
}
