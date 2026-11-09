import {
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsInt,
  IsIn,
  Min,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Zulaessige Steuersaetze fuer Pfand (Deutschland: 19, 7, 0). */
export const PFAND_VAT_RATES = [19, 7, 0] as const;

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
    example: 19,
    enum: PFAND_VAT_RATES,
    default: 19,
    description:
      'Umsatzsteuersatz des Pfands in Prozent: der Satz der Getränke/Waren, für die dieses Pfand gilt (meist 19). Pfand gehört zum Entgelt; die Rückgabe mindert Umsatz und Umsatzsteuer zum selben Satz. Steuerbefreite Organisationen (Kleinunternehmer) weisen trotzdem keine MwSt aus.',
  })
  @IsOptional()
  @IsIn([...PFAND_VAT_RATES])
  vatRate?: number;

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
