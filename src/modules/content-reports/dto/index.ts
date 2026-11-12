import {
  Equals,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  CONTENT_REPORT_ACTIONS,
  CONTENT_REPORT_REASONS,
  CONTENT_REPORT_STATUSES,
  type ContentReportAction,
  type ContentReportReason,
  type ContentReportStatus,
} from '../../../database/entities/content-report.entity';

/** Meldung ueber das oeffentliche Formular „Inhalt melden“. */
export class CreateContentReportDto {
  @ApiProperty({
    example: 'https://shop.openeos.de/3f1c…',
    description: 'Fundstelle (Adresse der gemeldeten Seite)',
    maxLength: 1000,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(1000)
  url: string;

  @ApiProperty({ enum: CONTENT_REPORT_REASONS, example: 'illegal' })
  @IsIn(CONTENT_REPORT_REASONS as unknown as string[])
  reason: ContentReportReason;

  @ApiProperty({
    description: 'Begründung: warum der Inhalt rechtswidrig ist',
    minLength: 20,
    maxLength: 5000,
  })
  @IsString()
  @MinLength(20)
  @MaxLength(5000)
  description: string;

  @ApiProperty({ example: 'Max Mustermann', minLength: 2, maxLength: 200 })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @ApiProperty({ example: 'max@example.com' })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({
    description:
      'Bestätigung, dass die Angaben in gutem Glauben richtig und vollständig sind (Art. 16 Abs. 2 lit. d DSA)',
    example: true,
  })
  @IsBoolean()
  @Equals(true, {
    message: 'Bitte bestätige, dass du die Meldung in gutem Glauben abgibst.',
  })
  goodFaith: boolean;

  // Honeypot-Feld: für Menschen unsichtbar, Bots füllen es meist aus.
  @ApiPropertyOptional({ description: 'Honeypot-Feld — muss leer bleiben' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string;

  @ApiProperty({
    example: 1735689600000,
    description: 'Zeitpunkt (epoch ms), zu dem das Formular geladen wurde',
  })
  @IsInt()
  startedAt: number;
}

/** Bearbeitung durch den Super-Admin. */
export class UpdateContentReportDto {
  @ApiPropertyOptional({ enum: CONTENT_REPORT_STATUSES })
  @IsOptional()
  @IsIn(CONTENT_REPORT_STATUSES as unknown as string[])
  status?: ContentReportStatus;

  @ApiPropertyOptional({
    enum: CONTENT_REPORT_ACTIONS,
    description:
      '`disable_shop` schaltet den Shop der Veranstaltung ab bzw. nimmt die Helferseite aus der Veröffentlichung (einmalig beim Speichern). `hide_content` hält eine von Hand ausgeführte Entfernung fest.',
  })
  @IsOptional()
  @IsIn(CONTENT_REPORT_ACTIONS as unknown as string[])
  action?: ContentReportAction;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  decision?: string;

  @ApiPropertyOptional({ maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  facts?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  ground?: string;

  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'Leer = Standardtext zu den Rechtsbehelfen',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  redress?: string;
}

export const CONTENT_REPORT_NOTIFY_TARGETS = [
  'reporter',
  'organization',
] as const;
export type ContentReportNotifyTarget =
  (typeof CONTENT_REPORT_NOTIFY_TARGETS)[number];

export class NotifyContentReportDto {
  @ApiProperty({
    enum: CONTENT_REPORT_NOTIFY_TARGETS,
    description:
      '`reporter` = Mitteilung der Entscheidung an den Meldenden (Art. 16 Abs. 5 DSA), `organization` = Begründung an den Verein (Art. 17 DSA)',
  })
  @IsIn(CONTENT_REPORT_NOTIFY_TARGETS as unknown as string[])
  target: ContentReportNotifyTarget;
}
