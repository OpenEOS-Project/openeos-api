import { IsString, IsOptional, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CancelOrderDto {
  @ApiPropertyOptional({ example: 'Kunde hat Bestellung storniert', description: 'Grund für die Stornierung' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
