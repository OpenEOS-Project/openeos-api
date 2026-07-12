import { IsEmail, IsIn, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type ContactRequestType = 'demo' | 'contact' | 'hardware' | 'gateway';

export class CreateContactRequestDto {
  @ApiProperty({ example: 'demo', enum: ['demo', 'contact', 'hardware', 'gateway'], description: 'Art der Anfrage' })
  @IsIn(['demo', 'contact', 'hardware', 'gateway'])
  type: ContactRequestType;

  @ApiProperty({ example: 'Max Mustermann', minLength: 2, maxLength: 100 })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: 'max@example.com' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ example: 'Musterverein e.V.', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  organization?: string;

  @ApiProperty({ example: 'Wir würden gerne eine Demo vereinbaren.', minLength: 10, maxLength: 3000 })
  @IsString()
  @MinLength(10)
  @MaxLength(3000)
  message: string;

  // Honeypot-Feld: für echte Nutzer unsichtbar, Bots füllen es meist aus.
  @ApiPropertyOptional({ description: 'Honeypot-Feld — muss leer bleiben' })
  @IsOptional()
  @IsString()
  website?: string;

  @ApiProperty({ example: 1735689600000, description: 'Zeitpunkt (epoch ms), zu dem das Formular geladen wurde' })
  @IsInt()
  startedAt: number;
}
