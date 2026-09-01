import {
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
  IsObject,
  IsDateString,
  IsNotEmpty,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateEventDto {
  @ApiProperty({ example: 'Sommerfest 2024', description: 'Name des Events' })
  @IsString()
  @MinLength(2, { message: 'Name muss mindestens 2 Zeichen lang sein' })
  @MaxLength(255, { message: 'Name darf maximal 255 Zeichen lang sein' })
  name: string;

  @ApiPropertyOptional({ example: 'Jährliches Sommerfest mit Livemusik und Buffet', description: 'Beschreibung des Events' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    example: '2024-07-15T10:00:00.000Z',
    description: 'Beginn der Veranstaltung. Pflichtangabe — der Preis und die Shop-Öffnungszeiten leiten sich davon ab.',
  })
  @IsNotEmpty({ message: 'Startdatum ist erforderlich' })
  @IsDateString({}, { message: 'Ungültiges Startdatum' })
  startDate: string;

  @ApiPropertyOptional({
    example: '2024-07-16T02:00:00.000Z',
    description: 'Ende der Veranstaltung. Ohne Angabe endet sie am Starttag. Darf über Mitternacht hinausgehen.',
  })
  @IsOptional()
  @IsDateString({}, { message: 'Ungültiges Enddatum' })
  endDate?: string;

  @ApiPropertyOptional({ example: { allowOnlineOrders: true, requireTableNumber: false }, description: 'Event-Einstellungen' })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}
