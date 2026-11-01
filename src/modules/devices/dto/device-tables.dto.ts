import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUIDLoose } from '../../../common/validators/is-uuid-loose.validator';

export class AcknowledgeTableDto {
  @ApiProperty({
    example: 'A03',
    description:
      'Tischschlüssel bzw. Tischbezeichnung (groß/klein und Leerzeichen am Rand egal)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  tableKey: string;

  @ApiPropertyOptional({
    description: 'Veranstaltung; ohne Angabe das aktive bzw. Test-Event',
  })
  @IsOptional()
  @IsUUID()
  eventId?: string;
}

/** „Abschließen“ im Modus „Nur Bestellen“ (statt „Kassieren“). */
export class CompleteOrdersDto {
  @ApiProperty({
    type: [String],
    description:
      'Offene Bestellungen, die ohne Zahlung abgeschlossen werden (z. B. alle eines Tisches)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUIDLoose({ each: true })
  orderIds: string[];
}

export class DeliverOrderItemsDto {
  @ApiProperty({
    type: [String],
    description: 'Fertige Positionen (Status ready), die serviert wurden',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUIDLoose({ each: true })
  itemIds: string[];
}
