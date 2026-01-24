import { IsString, IsEmail, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RequestEmailChangeDto {
  @ApiProperty({ example: 'neue-email@example.com', description: 'Neue E-Mail-Adresse' })
  @IsString()
  @IsEmail()
  @MaxLength(255)
  newEmail: string;

  @ApiProperty({ example: 'MeinPasswort123!', description: 'Aktuelles Passwort zur Bestätigung' })
  @IsString()
  @MinLength(1)
  password: string;
}

export class VerifyEmailChangeDto {
  @ApiProperty({ example: 'abc123...', description: 'Verifizierungstoken aus der E-Mail' })
  @IsString()
  token: string;
}
