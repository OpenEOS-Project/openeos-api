import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class RequestMagicLinkDto {
  @ApiProperty({ example: 'max@example.com', description: 'E-Mail-Adresse des Kontos' })
  @IsEmail({}, { message: 'Ungültige E-Mail-Adresse' })
  email: string;
}

export class VerifyMagicLinkDto {
  @ApiProperty({ description: 'Token aus dem zugesandten Anmeldelink' })
  @IsString()
  @MinLength(32, { message: 'Ungültiger Anmeldelink' })
  token: string;
}
