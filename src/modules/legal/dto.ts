import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsUUID,
} from 'class-validator';

import {
  LEGAL_DOCUMENTS,
  type LegalDocument,
} from '../../database/entities/legal-acceptance.entity';

export class AcceptLegalDto {
  @ApiPropertyOptional({
    enum: LEGAL_DOCUMENTS,
    isArray: true,
    description:
      'Welche Dokumente angenommen werden (`agb`, `avv`, `anlage1`). Ohne Angabe: beim Buchen alle, bei `reacceptance` die, die eine erneute Annahme verlangen (`reacceptanceRequired` in `/legal/status`).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(LEGAL_DOCUMENTS, { each: true })
  documents?: LegalDocument[];

  @ApiPropertyOptional({
    enum: ['reacceptance', 'purchase'],
    description:
      '`reacceptance` (Standard): neue Fassung nach dem Login; `purchase`: Annahme beim Buchen einer Veranstaltung.',
  })
  @IsOptional()
  @IsIn(['reacceptance', 'purchase'])
  context?: 'reacceptance' | 'purchase';

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Organisation, für die angenommen wird. Ohne Angabe: alle Organisationen, in denen du Admin bist.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;
}
