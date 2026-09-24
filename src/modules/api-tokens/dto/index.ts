import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsDateString, IsIn, IsOptional, IsString, Length } from 'class-validator';

import { ALLE_SCOPES, type ApiScope } from '../api-scopes';

export class CreateApiTokenDto {
  @ApiProperty({ example: 'Grafana', description: 'Wofür der Token gedacht ist' })
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiProperty({ example: ['monitoring:read'], enum: ALLE_SCOPES, isArray: true })
  @IsArray()
  @IsIn(ALLE_SCOPES, { each: true })
  scopes: ApiScope[];

  @ApiPropertyOptional({ description: 'Ohne Angabe läuft der Token nicht ab' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
