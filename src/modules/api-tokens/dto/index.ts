import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

import {
  ORGANIZATION_TOKEN_SCOPES,
  PLATFORM_TOKEN_SCOPES,
  TokenScope,
} from '../api-scopes';

/** Plattform-Token (Super-Admin, `admin/api-tokens`). */
export class CreateApiTokenDto {
  @ApiProperty({
    example: 'Grafana',
    description: 'Wofür der Token gedacht ist',
  })
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiProperty({
    example: ['monitoring:read'],
    enum: PLATFORM_TOKEN_SCOPES,
    isArray: true,
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(PLATFORM_TOKEN_SCOPES, { each: true })
  scopes: TokenScope[];

  @ApiPropertyOptional({
    description: 'Ohne Angabe läuft der Token nicht ab',
    example: '2027-01-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

/** Organisations-Token (`organizations/:organizationId/api-tokens`). */
export class CreateOrganizationApiTokenDto {
  @ApiProperty({
    example: 'Claude Desktop',
    description: 'Wofür der Token gedacht ist — erscheint in der Übersicht',
    maxLength: 100,
  })
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiProperty({
    example: ['read', 'catalog:write'],
    enum: ORGANIZATION_TOKEN_SCOPES,
    isArray: true,
    description:
      'Was der Token darf. Schreib-Scopes schließen `read` nicht ein — ' +
      'wer lesen und schreiben will, gibt beides an.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(ORGANIZATION_TOKEN_SCOPES, { each: true })
  scopes: TokenScope[];

  @ApiPropertyOptional({
    description: 'ISO-8601. Ohne Angabe läuft der Token nicht ab',
    example: '2027-01-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
