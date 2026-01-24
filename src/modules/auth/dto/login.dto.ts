import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'max@example.com', description: 'E-Mail-Adresse des Benutzers' })
  @IsEmail({}, { message: 'Ungültige E-Mail-Adresse' })
  email: string;

  @ApiProperty({ example: 'SecurePass123!', description: 'Passwort des Benutzers' })
  @IsString()
  @MinLength(1, { message: 'Passwort ist erforderlich' })
  password: string;
}
