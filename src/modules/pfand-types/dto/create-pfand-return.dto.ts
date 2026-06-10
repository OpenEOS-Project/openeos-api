import {
  IsArray,
  IsOptional,
  IsUUID,
  IsInt,
  Min,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PfandReturnLineDto {
  @ApiProperty({ description: 'ID des Pfand-Typs' })
  @IsUUID()
  pfandTypeId: string;

  @ApiProperty({ example: 3, description: 'Anzahl zurückgegebener Einheiten' })
  @IsInt()
  @Min(1)
  quantity: number;
}

export class CreatePfandReturnDto {
  @ApiPropertyOptional({ description: 'Optionale Event-ID' })
  @IsOptional()
  @IsUUID()
  eventId?: string;

  @ApiProperty({
    type: [PfandReturnLineDto],
    description: 'Zurückgegebene Pfand-Positionen',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PfandReturnLineDto)
  lines: PfandReturnLineDto[];
}
