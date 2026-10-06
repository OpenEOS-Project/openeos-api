import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
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
import type { TableAreaDecorType } from '../../../database/entities/table-area.entity';
import {
  AREA_SIZE_MAX,
  AREA_SIZE_MIN,
  DECOR_MAX,
  GRID_SIZE_MAX,
  GRID_SIZE_MIN,
  NO_CONTROL_CHARS,
  ROTATION_MAX,
  TABLE_SIZE_MAX,
  TABLE_SIZE_MIN,
} from '../tables.constants';

export const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const DECOR_TYPES: TableAreaDecorType[] = ['bar', 'wall', 'stage', 'label'];

export class CreateTableAreaDto {
  @ApiProperty({ example: 'Zelt A', description: 'Name des Bereichs' })
  @Transform(trimString)
  @IsString()
  @MinLength(1, { message: 'Gib einen Namen für den Bereich an' })
  @MaxLength(60, { message: 'Der Name darf höchstens 60 Zeichen lang sein' })
  @Matches(NO_CONTROL_CHARS, {
    message: 'Der Name enthält ungültige Zeichen',
  })
  name: string;

  @ApiPropertyOptional({ example: 1200, description: 'Breite der Karte' })
  @IsOptional()
  @IsInt()
  @Min(AREA_SIZE_MIN)
  @Max(AREA_SIZE_MAX)
  width?: number;

  @ApiPropertyOptional({ example: 800, description: 'Höhe der Karte' })
  @IsOptional()
  @IsInt()
  @Min(AREA_SIZE_MIN)
  @Max(AREA_SIZE_MAX)
  height?: number;

  @ApiPropertyOptional({ example: 20, description: 'Rasterweite' })
  @IsOptional()
  @IsInt()
  @Min(GRID_SIZE_MIN)
  @Max(GRID_SIZE_MAX)
  gridSize?: number;
}

export class TableAreaDecorDto {
  @ApiProperty({ example: 'd1', description: 'Vom Client vergebene ID' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  id: string;

  @ApiProperty({ enum: DECOR_TYPES })
  @IsIn(DECOR_TYPES)
  type: TableAreaDecorType;

  @ApiProperty() @IsInt() @Min(0) @Max(AREA_SIZE_MAX) x: number;
  @ApiProperty() @IsInt() @Min(0) @Max(AREA_SIZE_MAX) y: number;
  @ApiProperty() @IsInt() @Min(1) @Max(AREA_SIZE_MAX) width: number;
  @ApiProperty() @IsInt() @Min(1) @Max(AREA_SIZE_MAX) height: number;

  @ApiProperty({ example: 0 })
  @IsInt()
  @Min(0)
  @Max(ROTATION_MAX)
  rotation: number;

  @ApiPropertyOptional({ example: 'Theke' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Matches(NO_CONTROL_CHARS)
  label?: string;
}

export class UpdateTableAreaDto extends PartialType(CreateTableAreaDto) {
  @ApiPropertyOptional({ type: [TableAreaDecorDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DECOR_MAX, {
    message: `Ein Bereich kann höchstens ${DECOR_MAX} Deko-Elemente haben`,
  })
  @ValidateNested({ each: true })
  @Type(() => TableAreaDecorDto)
  decor?: TableAreaDecorDto[];
}

export class ReorderTableAreasDto {
  @ApiProperty({
    type: [String],
    description: 'Bereichs-IDs in neuer Reihenfolge',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsUUIDLoose({ each: true })
  ids: string[];
}

export class LayoutTableDto {
  @ApiProperty()
  @IsUUIDLoose()
  id: string;

  @ApiProperty() @IsInt() @Min(0) @Max(AREA_SIZE_MAX) x: number;
  @ApiProperty() @IsInt() @Min(0) @Max(AREA_SIZE_MAX) y: number;

  @ApiProperty()
  @IsInt()
  @Min(TABLE_SIZE_MIN)
  @Max(TABLE_SIZE_MAX)
  width: number;

  @ApiProperty()
  @IsInt()
  @Min(TABLE_SIZE_MIN)
  @Max(TABLE_SIZE_MAX)
  height: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  @Max(ROTATION_MAX)
  rotation: number;

  @ApiPropertyOptional({ enum: DiningTableShape })
  @IsOptional()
  @IsIn(Object.values(DiningTableShape))
  shape?: DiningTableShape;
}

export class PutTableAreaLayoutDto {
  @ApiProperty({ type: [LayoutTableDto] })
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => LayoutTableDto)
  tables: LayoutTableDto[];

  @ApiPropertyOptional({ type: [TableAreaDecorDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DECOR_MAX, {
    message: `Ein Bereich kann höchstens ${DECOR_MAX} Deko-Elemente haben`,
  })
  @ValidateNested({ each: true })
  @Type(() => TableAreaDecorDto)
  decor?: TableAreaDecorDto[];
}
