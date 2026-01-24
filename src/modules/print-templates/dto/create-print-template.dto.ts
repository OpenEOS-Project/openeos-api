import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  MaxLength,
  IsObject,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PrintTemplateType } from '../../../database/entities/print-template.entity';
import type { PrintTemplateDefinition } from '../../../database/entities/print-template.entity';

export class CreatePrintTemplateDto {
  @ApiProperty({ example: 'Kassenbon Standard', description: 'Name der Druckvorlage' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: 'receipt', description: 'Typ der Druckvorlage', enum: PrintTemplateType })
  @IsEnum(PrintTemplateType)
  type: PrintTemplateType;

  @ApiPropertyOptional({ example: { header: 'Musterverein e.V.', showLogo: true }, description: 'Vorlagen-Definition' })
  @IsOptional()
  @IsObject()
  template?: PrintTemplateDefinition;

  @ApiPropertyOptional({ example: false, description: 'Gibt an, ob dies die Standardvorlage ist' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
