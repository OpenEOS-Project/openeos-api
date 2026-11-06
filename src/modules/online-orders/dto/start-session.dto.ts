import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsUUID, MaxLength } from 'class-validator';

/**
 * Bestellen am Tisch beginnt mit dem Scan eines QR-Codes der Organisation.
 * Ohne `code` antwortet die API mit 400 `QR_CODE_REQUIRED` — Bestellungen
 * ohne QR-Code (nur mit Organisations-ID) gibt es nicht: der Code ist das,
 * was eine Bestellung an Tisch und Veranstaltung bindet und Fremde aus der
 * Kueche haelt. Online ohne Tisch bestellen Gaeste im Shop.
 */
export class StartSessionDto {
  @ApiProperty({
    example: 'ABC123',
    description: 'Code des gescannten QR-Codes (Pflicht)',
  })
  // Pflicht prueft der Dienst (400 QR_CODE_REQUIRED statt allgemeinem
  // Validierungsfehler); hier nur die Form.
  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;

  @ApiPropertyOptional({
    deprecated: true,
    description:
      'Nicht mehr unterstützt — ohne `code` antwortet die API mit 400 QR_CODE_REQUIRED.',
  })
  @IsOptional()
  @IsUUID()
  eventId?: string;

  @ApiPropertyOptional({
    deprecated: true,
    description:
      'Nicht mehr unterstützt — ohne `code` antwortet die API mit 400 QR_CODE_REQUIRED.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({
    example: '5',
    description:
      'Tischnummer, falls der QR-Code keine eigene hat (Tischnummer des QR-Codes hat Vorrang)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tableNumber?: string;
}
