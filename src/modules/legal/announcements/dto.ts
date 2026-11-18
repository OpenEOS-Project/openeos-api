import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { LEGAL_DOCUMENT_KEYS } from '../../../config/legal.config';
import type { LegalDocumentKey } from '../../../config/legal.config';

export class LegalAnnouncementDto {
  @ApiProperty({
    enum: LEGAL_DOCUMENT_KEYS,
    isArray: true,
    description:
      'Geänderte Dokumente: `agb`, `anlage1` (Leistungsbeschreibung und Preisliste), `avv`, `privacy`, `imprint`.',
  })
  @IsArray()
  @ArrayMaxSize(5)
  @IsIn(LEGAL_DOCUMENT_KEYS, { each: true })
  documents: LegalDocumentKey[];

  @ApiProperty({
    example: '2027-01-15',
    description:
      'Neue Fassung = Tag des Inkrafttretens (JJJJ-MM-TT). AGB, Anlage 1 und AVV mindestens sechs Wochen im Voraus.',
  })
  @IsString()
  @MaxLength(10)
  version: string;

  @ApiProperty({
    description: 'Was sich ändert, auf Deutsch (10–4000 Zeichen).',
  })
  @IsString()
  @MaxLength(4000)
  summaryDe: string;

  @ApiPropertyOptional({
    description: 'Optional: dieselbe Zusammenfassung auf Englisch.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  summaryEn?: string;

  @ApiPropertyOptional({
    description:
      'Kürzere Frist als sechs Wochen — nur für gesetzlich oder behördlich veranlasste Änderungen.',
  })
  @IsOptional()
  @IsBoolean()
  shortNotice?: boolean;

  @ApiPropertyOptional({
    description:
      'Nur mit ausdrücklicher Zustimmung wirksam (Hauptleistungen, Vergütung, Auftragsverarbeitungsvertrag): die Mail fragt nach Zustimmung statt auf das Widerspruchsrecht hinzuweisen.',
  })
  @IsOptional()
  @IsBoolean()
  explicitConsent?: boolean;
}
