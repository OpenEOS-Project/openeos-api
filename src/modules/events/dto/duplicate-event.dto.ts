import {
  IsBoolean,
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DuplicateEventDto {
  @ApiProperty({ example: 'Sommerfest 2027', description: 'Name der Kopie' })
  @IsString()
  @MinLength(2, { message: 'Name muss mindestens 2 Zeichen lang sein' })
  @MaxLength(255, { message: 'Name darf maximal 255 Zeichen lang sein' })
  name: string;

  @ApiPropertyOptional({
    description: 'Beschreibung; ohne Angabe die der Vorlage',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    example: '2027-07-15T00:00:00.000Z',
    description:
      'Beginn der Kopie. Shop-Öffnungstage und Schichten wandern um denselben Abstand in Kalendertagen mit.',
  })
  @IsNotEmpty({ message: 'Startdatum ist erforderlich' })
  @IsDateString({}, { message: 'Ungültiges Startdatum' })
  startDate: string;

  @ApiPropertyOptional({
    example: '2027-07-16T00:00:00.000Z',
    description: 'Ende der Kopie; ohne Angabe endet sie am Starttag.',
  })
  @IsOptional()
  @IsDateString({}, { message: 'Ungültiges Enddatum' })
  endDate?: string;

  @ApiPropertyOptional({
    example: false,
    description: 'Bestand der Produkte mitnehmen. Standard: false (Bestand 0).',
  })
  @IsOptional()
  @IsBoolean()
  copyStock?: boolean;
}
