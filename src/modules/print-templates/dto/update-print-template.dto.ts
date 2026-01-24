import {
  IsString,
  IsOptional,
  IsBoolean,
  MaxLength,
  IsObject,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import type { PrintTemplateDefinition } from '../../../database/entities/print-template.entity';

export class UpdatePrintTemplateDto {
  @ApiPropertyOptional({ example: 'Kassenbon Standard', description: 'Name der Druckvorlage' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ example: { header: 'Musterverein e.V.', showLogo: true }, description: 'Vorlagen-Definition' })
  @IsOptional()
  @IsObject()
  template?: PrintTemplateDefinition;

  @ApiPropertyOptional({ example: true, description: 'Gibt an, ob dies die Standardvorlage ist' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
