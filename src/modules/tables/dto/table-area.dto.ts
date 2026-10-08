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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsUUIDLoose } from '../../../common/validators/is-uuid-loose.validator';
import { DiningTableShape } from '../../../database/entities/dining-table.entity';
import type {
  TableAreaDecorType,
  TableAreaZoneType,
} from '../../../database/entities/table-area.entity';
import {
  AREA_SIZE_MAX,
  AREA_SIZE_MIN,
  DECOR_MAX,
  GRID_SIZE_MAX,
  GRID_SIZE_MIN,
  LINE_POINTS_MIN,
  NO_CONTROL_CHARS,
  POLYGON_POINTS_MIN,
  ROTATION_MAX,
  TABLE_SIZE_MAX,
  SHAPE_POINTS_MAX,
  TABLE_SIZE_MIN,
  WALL_THICKNESS_MAX,
  WALL_THICKNESS_MIN,
} from '../tables.constants';

export const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const DECOR_TYPES: TableAreaDecorType[] = [
  'bar',
  'wall',
  'stage',
  'label',
  'zone',
];
const ZONE_TYPES: TableAreaZoneType[] = ['kitchen', 'blocked', 'bar', 'other'];

/**
 * Element aus Punkten? `zone` immer, `wall` nur mit `points` (Linienzug);
 * alles andere ist ein Rechteck wie bisher.
 */
export const isShapeDecor = (o: { type?: unknown; points?: unknown }) =>
  o.type === 'zone' || (o.type === 'wall' && o.points !== undefined);

export class TableAreaPointDto {
  @ApiProperty({ example: 120 })
  @IsInt()
  @Min(0)
  @Max(AREA_SIZE_MAX)
  x: number;

  @ApiProperty({ example: 40 })
  @IsInt()
  @Min(0)
  @Max(AREA_SIZE_MAX)
  y: number;
}

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

  // Rechteck (bar, stage, label, wall ohne `points`)
  @ApiPropertyOptional({ description: 'Nur Rechteck-Elemente' })
  @ValidateIf((o: TableAreaDecorDto) => !isShapeDecor(o))
  @IsInt()
  @Min(0)
  @Max(AREA_SIZE_MAX)
  x?: number;

  @ApiPropertyOptional({ description: 'Nur Rechteck-Elemente' })
  @ValidateIf((o: TableAreaDecorDto) => !isShapeDecor(o))
  @IsInt()
  @Min(0)
  @Max(AREA_SIZE_MAX)
  y?: number;

  @ApiPropertyOptional({ description: 'Nur Rechteck-Elemente' })
  @ValidateIf((o: TableAreaDecorDto) => !isShapeDecor(o))
  @IsInt()
  @Min(1)
  @Max(AREA_SIZE_MAX)
  width?: number;

  @ApiPropertyOptional({ description: 'Nur Rechteck-Elemente' })
  @ValidateIf((o: TableAreaDecorDto) => !isShapeDecor(o))
  @IsInt()
  @Min(1)
  @Max(AREA_SIZE_MAX)
  height?: number;

  @ApiPropertyOptional({ example: 0, description: 'Nur Rechteck-Elemente' })
  @ValidateIf((o: TableAreaDecorDto) => !isShapeDecor(o))
  @IsInt()
  @Min(0)
  @Max(ROTATION_MAX)
  rotation?: number;

  // Linienzug (wall mit points) bzw. Polygon (zone)
  @ApiPropertyOptional({
    type: [TableAreaPointDto],
    description:
      'Wand als Linienzug (>= 2 Punkte) bzw. Zone (>= 3 Punkte), höchstens 100',
  })
  @ValidateIf((o: TableAreaDecorDto) => isShapeDecor(o))
  @IsArray({ message: 'Eine Zone braucht Punkte' })
  @ArrayMinSize(LINE_POINTS_MIN, {
    message: `Eine Wand braucht mindestens ${LINE_POINTS_MIN} Punkte`,
  })
  @ArrayMaxSize(SHAPE_POINTS_MAX, {
    message: `Höchstens ${SHAPE_POINTS_MAX} Punkte je Wand oder Zone`,
  })
  @ValidateNested({ each: true })
  @Type(() => TableAreaPointDto)
  points?: TableAreaPointDto[];

  @ApiPropertyOptional({ example: 10, description: 'Nur Wand als Linienzug' })
  @IsOptional()
  @IsInt()
  @Min(WALL_THICKNESS_MIN)
  @Max(WALL_THICKNESS_MAX)
  thickness?: number;

  @ApiPropertyOptional({ enum: ZONE_TYPES, description: 'Nur Zonen' })
  @ValidateIf((o: TableAreaDecorDto) => o.type === 'zone')
  @IsIn(ZONE_TYPES, {
    message: 'Wähle einen Zonentyp: Küche, Gesperrt, Bar/Theke oder Sonstiges',
  })
  zoneType?: TableAreaZoneType;

  @ApiPropertyOptional({ example: 'Theke' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Matches(NO_CONTROL_CHARS)
  label?: string;
}

/** Umriss: Polygon mit 3 bis 100 Punkten; `null` = Rechteck der Karte. */
function OutlineProperty(): PropertyDecorator {
  return (target, key) => {
    const decorators: PropertyDecorator[] = [
      ApiPropertyOptional({
        type: [TableAreaPointDto],
        nullable: true,
        description:
          'Umriss des Raums (Polygon, 3–100 Punkte); null = ganze Karte',
      }),
      IsOptional(),
      IsArray(),
      ArrayMinSize(POLYGON_POINTS_MIN, {
        message: `Die Raumform braucht mindestens ${POLYGON_POINTS_MIN} Punkte`,
      }),
      ArrayMaxSize(SHAPE_POINTS_MAX, {
        message: `Die Raumform darf höchstens ${SHAPE_POINTS_MAX} Punkte haben`,
      }),
      ValidateNested({ each: true }),
      Type(() => TableAreaPointDto),
    ];
    for (const decorate of decorators) decorate(target, key);
  };
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

  @OutlineProperty()
  outline?: TableAreaPointDto[] | null;
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

  @OutlineProperty()
  outline?: TableAreaPointDto[] | null;
}
