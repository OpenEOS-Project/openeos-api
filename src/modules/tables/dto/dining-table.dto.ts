import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsUUIDLoose } from '../../../common/validators/is-uuid-loose.validator';
import { DiningTableShape } from '../../../database/entities/dining-table.entity';
import {
  AREA_SIZE_MAX,
  BULK_MAX,
  LABEL_MAX,
  NO_CONTROL_CHARS,
  ROTATION_MAX,
  SEATS_MAX,
  TABLE_SIZE_MAX,
  TABLE_SIZE_MIN,
} from '../tables.constants';
import { trimString } from './table-area.dto';

const SHAPES = Object.values(DiningTableShape);

export class CreateDiningTableDto {
  @ApiProperty()
  @IsUUIDLoose()
  areaId: string;

  @ApiProperty({ example: 'A03', description: 'Bezeichnung (1–20 Zeichen)' })
  @Transform(trimString)
  @IsString()
  @MinLength(1, { message: 'Gib eine Tischbezeichnung an' })
  @MaxLength(LABEL_MAX, {
    message: `Die Tischbezeichnung darf höchstens ${LABEL_MAX} Zeichen lang sein`,
  })
  @Matches(NO_CONTROL_CHARS, {
    message: 'Die Tischbezeichnung enthält ungültige Zeichen',
  })
  label: string;

  @ApiPropertyOptional({ example: 6, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(SEATS_MAX)
  seats?: number | null;

  @ApiPropertyOptional({ enum: DiningTableShape })
  @IsOptional()
  @IsIn(SHAPES)
  shape?: DiningTableShape;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(AREA_SIZE_MAX)
  x?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(AREA_SIZE_MAX)
  y?: number;

  @ApiPropertyOptional({ example: 80 })
  @IsOptional()
  @IsInt()
  @Min(TABLE_SIZE_MIN)
  @Max(TABLE_SIZE_MAX)
  width?: number;

  @ApiPropertyOptional({ example: 80 })
  @IsOptional()
  @IsInt()
  @Min(TABLE_SIZE_MIN)
  @Max(TABLE_SIZE_MAX)
  height?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(ROTATION_MAX)
  rotation?: number;
}

/** Alle Felder optional; `areaId` verschiebt den Tisch in einen anderen Bereich. */
export class UpdateDiningTableDto extends PartialType(CreateDiningTableDto) {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class BulkLayoutDto {
  @ApiProperty({ example: 6, description: 'Tische je Reihe' })
  @IsInt()
  @Min(1)
  @Max(50)
  cols: number;

  @ApiProperty({ example: 40, description: 'Abstand zwischen den Tischen' })
  @IsInt()
  @Min(0)
  @Max(500)
  gap: number;
}

export class BulkCreateDiningTablesDto {
  @ApiProperty()
  @IsUUIDLoose()
  areaId: string;

  @ApiProperty({ example: 'A', description: 'Präfix, darf leer sein' })
  @Transform(trimString)
  @IsString()
  @MaxLength(LABEL_MAX - 1, {
    message: `Das Präfix darf höchstens ${LABEL_MAX - 1} Zeichen lang sein`,
  })
  @Matches(/^[^\p{Cc}]*$/u, { message: 'Das Präfix enthält ungültige Zeichen' })
  prefix: string;

  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(0)
  @Max(99999)
  start: number;

  @ApiProperty({ example: 12, description: '1–100 Tische' })
  @IsInt()
  @Min(1, { message: 'Lege mindestens einen Tisch an' })
  @Max(BULK_MAX, {
    message: `Du kannst höchstens ${BULK_MAX} Tische auf einmal anlegen`,
  })
  count: number;

  @ApiProperty({ example: 2, description: 'Stellen der Nummer (0–3)' })
  @IsInt()
  @Min(0)
  @Max(3)
  padding: number;

  @ApiPropertyOptional({ example: 6 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(SEATS_MAX)
  seats?: number;

  @ApiPropertyOptional({ enum: DiningTableShape })
  @IsOptional()
  @IsIn(SHAPES)
  shape?: DiningTableShape;

  @ApiPropertyOptional({ type: BulkLayoutDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BulkLayoutDto)
  layout?: BulkLayoutDto;
}
