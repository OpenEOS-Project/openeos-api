import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Widerrufserklaerung ueber die Widerrufsfunktion (§ 356a BGB). */
export class CreateShopWithdrawalDto {
  @ApiProperty({ example: 'Erika Muster', minLength: 2, maxLength: 200 })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @ApiProperty({
    example: 'erika@example.com',
    description: 'Adresse für die Eingangsbestätigung',
  })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({
    example: 'W-20261115-0042',
    description: 'Bestellnummer aus der Bestellbestätigung',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  orderNumber: string;

  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'Freiwillig: welche Positionen bzw. weitere Angaben',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;

  // Honeypot-Feld: für Menschen unsichtbar, Bots füllen es meist aus.
  @ApiPropertyOptional({ description: 'Honeypot-Feld — muss leer bleiben' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string;

  @ApiPropertyOptional({
    description: 'Zeitpunkt (epoch ms), zu dem das Formular geladen wurde',
  })
  @IsOptional()
  @IsInt()
  startedAt?: number;
}
