import { IsString, IsOptional, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class SubmitOrderDto {
  @ApiPropertyOptional({ example: 'Max Mustermann', description: 'Name des Kunden' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  customerName?: string;

  @ApiPropertyOptional({ example: 'Bitte alles zusammen servieren', description: 'Allgemeine Notizen zur Bestellung' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
