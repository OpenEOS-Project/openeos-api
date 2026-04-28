import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsArray,
  IsBoolean,
  ValidateNested,
  MaxLength,
  IsNumber,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderPriority, OrderSource, OrderFulfillmentType } from '../../../database/entities/order.entity';
import { IsUUIDLoose } from '../../../common/validators/is-uuid-loose.validator';

export class SelectedOptionDto {
  @ApiProperty({ example: 'Größe', description: 'Name der Optionsgruppe' })
  @IsString()
  group: string;

  @ApiProperty({ example: 'Groß', description: 'Name der gewählten Option' })
  @IsString()
  option: string;

  @ApiProperty({ example: 1.50, description: 'Preismodifikator' })
  @IsNumber()
  priceModifier: number;

  @ApiPropertyOptional({ example: true, description: 'Ob die Zutat ausgeschlossen ist' })
  @IsOptional()
  @IsBoolean()
  excluded?: boolean;
}

export class CreateOrderItemDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'ID des Produkts' })
  @IsUUIDLoose()
  productId: string;

  @ApiProperty({ example: 2, description: 'Anzahl der bestellten Einheiten' })
  @IsNumber()
  @Min(1)
  quantity: number;

  @ApiPropertyOptional({ example: 'Ohne Zwiebeln', description: 'Allgemeine Notizen zur Position' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({ example: 'Medium gebraten', description: 'Notizen für die Küche' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  kitchenNotes?: string;

  @ApiPropertyOptional({ type: [SelectedOptionDto], description: 'Ausgewählte Produktoptionen' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SelectedOptionDto)
  selectedOptions?: SelectedOptionDto[];
}

export class CreateOrderDto {
  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'ID des Events' })
  @IsOptional()
  @IsUUID()
  eventId?: string;

  @ApiPropertyOptional({ example: 'T5', description: 'Tischnummer' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tableNumber?: string;

  @ApiPropertyOptional({ example: 'Max Mustermann', description: 'Name des Kunden' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  customerName?: string;

  @ApiPropertyOptional({ example: '+49 170 1234567', description: 'Telefonnummer des Kunden' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  customerPhone?: string;

  @ApiPropertyOptional({ example: 'Bitte zusammen servieren', description: 'Allgemeine Bestellnotizen' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({ example: 'normal', description: 'Priorität der Bestellung', enum: OrderPriority })
  @IsOptional()
  @IsEnum(OrderPriority)
  priority?: OrderPriority;

  @ApiPropertyOptional({ example: 'pos', description: 'Quelle der Bestellung', enum: OrderSource })
  @IsOptional()
  @IsEnum(OrderSource)
  source?: OrderSource;

  @ApiPropertyOptional({ example: 'counter_pickup', description: 'Erfüllungstyp der Bestellung', enum: OrderFulfillmentType })
  @IsOptional()
  @IsEnum(OrderFulfillmentType)
  fulfillmentType?: OrderFulfillmentType;

  @ApiPropertyOptional({ type: [CreateOrderItemDto], description: 'Liste der Bestellpositionen' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items?: CreateOrderItemDto[];
}
