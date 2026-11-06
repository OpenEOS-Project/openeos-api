import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { RETENTION_CATEGORIES } from '../retention.types';
import type { RetentionCategory } from '../retention.types';
import { ERASURE_KINDS } from '../retention-erasure.service';
import type { ErasureKind } from '../retention-erasure.service';

export class ListRetentionRunsQueryDto {
  @ApiPropertyOptional({ enum: RETENTION_CATEGORIES })
  @IsOptional()
  @IsIn(RETENTION_CATEGORIES)
  category?: RetentionCategory;

  @ApiPropertyOptional({
    enum: ['scheduled', 'manual', 'instruction', 'self_service'],
  })
  @IsOptional()
  @IsIn(['scheduled', 'manual', 'instruction', 'self_service'])
  trigger?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class ListRetentionNoticesQueryDto {
  @ApiPropertyOptional({
    description: '`true`: nur offene, `false`: nur erledigte/aufgehobene',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  open?: 'true' | 'false';

  @ApiPropertyOptional({ enum: ['organization', 'user'] })
  @IsOptional()
  @IsIn(['organization', 'user'])
  subjectType?: 'organization' | 'user';
}

export class StartRetentionRunDto {
  @ApiPropertyOptional({
    enum: RETENTION_CATEGORIES,
    isArray: true,
    description: 'Nur diese Datenarten (leer: alle eingestellten)',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(RETENTION_CATEGORIES, { each: true })
  categories?: RetentionCategory[];

  @ApiPropertyOptional({
    description:
      'Probelauf (nur zählen). Ohne Angabe gilt RETENTION_DRY_RUN der Instanz.',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class EraseRecordDto {
  @ApiProperty({
    enum: ERASURE_KINDS,
    description:
      '`order`: Gästeangaben einer Bestellung · `guest_email`: alle Bestellangaben zu einer E-Mail-Adresse · `shift_registration`: eine Schichtanmeldung (ganze Eingabe) · `helper_email`: alle Schichtanmeldungen zu einer E-Mail-Adresse',
  })
  @IsIn(ERASURE_KINDS)
  kind: ErasureKind;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Bei `order` und `shift_registration`',
  })
  @ValidateIf((o: EraseRecordDto) =>
    ['order', 'shift_registration'].includes(o.kind),
  )
  @IsUUID()
  id?: string;

  @ApiPropertyOptional({ description: 'Bei `guest_email` und `helper_email`' })
  @ValidateIf((o: EraseRecordDto) =>
    ['guest_email', 'helper_email'].includes(o.kind),
  )
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiProperty({
    description:
      'Anlass für das Protokoll, z. B. „Weisung per E-Mail vom 04.11.2026, Ticket 123“. Keine Namen oder Inhalte.',
    minLength: 3,
    maxLength: 500,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({ description: 'Nur zählen, nichts ändern' })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

/** Sofortige endgueltige Loeschung einer Organisation auf Verlangen. */
export class PurgeOrganizationDto {
  @ApiProperty({
    description:
      'Name der Organisation zur Bestätigung, genau wie gespeichert (Leerzeichen am Rand werden ignoriert).',
    maxLength: 255,
  })
  @IsString()
  @MaxLength(255)
  confirmName: string;

  @ApiProperty({
    description:
      'Anlass für das Protokoll, z. B. „Löschverlangen per E-Mail vom 06.11.2026 (AVV 10.2)“. Keine Namen oder Inhalte.',
    minLength: 10,
    maxLength: 500,
  })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({ description: 'Nur zählen, nichts ändern' })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

/** Bestaetigung fuer „Konto löschen“: Passwort oder Code aus der E-Mail. */
export class DeleteAccountDto {
  @ApiPropertyOptional({
    description: 'Aktuelles Passwort (Konten mit Passwort)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  password?: string;

  @ApiPropertyOptional({
    description: 'Code aus der E-Mail (Konten ohne Passwort)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;
}
