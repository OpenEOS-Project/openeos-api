import {
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
  IsObject,
  IsDateString,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateEventDto {
  @ApiPropertyOptional({ example: 'Sommerfest 2024', description: 'Name des Events' })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Name muss mindestens 2 Zeichen lang sein' })
  @MaxLength(255, { message: 'Name darf maximal 255 Zeichen lang sein' })
  name?: string;

  @ApiPropertyOptional({ example: 'Jährliches Sommerfest mit Livemusik und Buffet', description: 'Beschreibung des Events' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: '2024-07-15T10:00:00.000Z', description: 'Startdatum und -zeit des Events' })
  @IsOptional()
  @IsDateString({}, { message: 'Ungültiges Startdatum' })
  startDate?: string;

  @ApiPropertyOptional({ example: '2024-07-15T22:00:00.000Z', description: 'Enddatum und -zeit des Events' })
  @IsOptional()
  @IsDateString({}, { message: 'Ungültiges Enddatum' })
  endDate?: string;

  @ApiPropertyOptional({ example: { allowOnlineOrders: true, requireTableNumber: false }, description: 'Event-Einstellungen' })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}
