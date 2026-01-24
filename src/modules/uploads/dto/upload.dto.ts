import { IsOptional, IsString, IsEnum, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum UploadCategory {
  PRODUCT = 'product',
  CATEGORY = 'category',
  ORGANIZATION = 'organization',
  USER = 'user',
  EVENT = 'event',
}

export class UploadImageDto {
  @ApiPropertyOptional({ example: 'product', description: 'Kategorie des Uploads', enum: UploadCategory })
  @IsOptional()
  @IsEnum(UploadCategory)
  category?: UploadCategory;

  @ApiPropertyOptional({ example: 'Produktbild für Wiener Schnitzel', description: 'Beschreibung des Uploads' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}
