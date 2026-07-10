import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class ResendVerificationDto {
  @ApiProperty({ example: 'max@example.com', description: 'E-Mail-Adresse des Kontos' })
  @IsEmail({}, { message: 'Ungültige E-Mail-Adresse' })
  email: string;
}
