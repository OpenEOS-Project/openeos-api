import {
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsInt,
  Min,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePfandTypeDto {
  @ApiProperty({ example: 'Becher', description: 'Name des Pfand-Typs' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: 2.0, description: 'Pfandbetrag pro Einheit in EUR' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Ob der Pfand-Typ aktiv (an der Kasse nutzbar) ist',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ example: 0, description: 'Sortierreihenfolge' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
