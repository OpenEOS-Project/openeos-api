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
import {
  OrderPriority,
  OrderSource,
  OrderFulfillmentType,
} from '../../../database/entities/order.entity';
import { IsUUIDLoose } from '../../../common/validators/is-uuid-loose.validator';

export class SelectedOptionDto {
  @ApiProperty({ example: 'Größe', description: 'Name der Optionsgruppe' })
  @IsString()
  group: string;

  @ApiProperty({ example: 'Groß', description: 'Name der gewählten Option' })
  @IsString()
  option: string;

  @ApiProperty({ example: 1.5, description: 'Preismodifikator' })
  @IsNumber()
  priceModifier: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Ob die Zutat ausgeschlossen ist',
  })
  @IsOptional()
  @IsBoolean()
  excluded?: boolean;
}

export class CreateOrderItemDto {
  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'ID des Produkts',
  })
  @IsUUIDLoose()
  productId: string;

  @ApiProperty({ example: 2, description: 'Anzahl der bestellten Einheiten' })
  @IsNumber()
  @Min(1)
  quantity: number;

  @ApiPropertyOptional({
    example: 'Ohne Zwiebeln',
    description: 'Allgemeine Notizen zur Position',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({
    example: 'Medium gebraten',
    description: 'Notizen für die Küche',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  kitchenNotes?: string;

  @ApiPropertyOptional({
    type: [SelectedOptionDto],
    description: 'Ausgewählte Produktoptionen',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SelectedOptionDto)
  selectedOptions?: SelectedOptionDto[];

  @ApiPropertyOptional({
    example: false,
    description: 'Nachfüllen: kein Pfand berechnen (Gast nutzt eigenen Becher)',
  })
  @IsOptional()
  @IsBoolean()
  isRefill?: boolean;
}

export class CreateOrderDto {
  @ApiPropertyOptional({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'ID des Events',
  })
  @IsOptional()
  @IsUUID()
  eventId?: string;

  @ApiPropertyOptional({ example: 'T5', description: 'Tischnummer' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tableNumber?: string;

  @ApiPropertyOptional({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description:
      'Vordefinierter Tisch (nur Geräte-API). Pflicht im Tischmodus „predefined“, im Modus „free“ best effort.',
  })
  @IsOptional()
  @IsUUID()
  tableId?: string;

  @ApiPropertyOptional({
    example: '0b6c1f2e-4f7a-4d8e-9b1a-2c3d4e5f6a7b',
    description:
      'Vom Gerät je Anlageversuch vergebene UUID (nur Geräte-API). Eine Wiederholung mit derselben ID liefert die bereits angelegte Bestellung (HTTP 200) statt einer zweiten.',
  })
  @IsOptional()
  @IsUUID()
  clientRequestId?: string;

  @ApiPropertyOptional({
    example: 'Max Mustermann',
    description: 'Name des Kunden',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  customerName?: string;

  @ApiPropertyOptional({
    example: '+49 170 1234567',
    description: 'Telefonnummer des Kunden',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  customerPhone?: string;

  @ApiPropertyOptional({
    example: 'Bitte zusammen servieren',
    description: 'Allgemeine Bestellnotizen',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({
    example: 'normal',
    description: 'Priorität der Bestellung',
    enum: OrderPriority,
  })
  @IsOptional()
  @IsEnum(OrderPriority)
  priority?: OrderPriority;

  @ApiPropertyOptional({
    example: 'pos',
    description: 'Quelle der Bestellung',
    enum: OrderSource,
  })
  @IsOptional()
  @IsEnum(OrderSource)
  source?: OrderSource;

  @ApiPropertyOptional({
    example: 'counter_pickup',
    description:
      'Erfüllungstyp der Bestellung. Geräte-API: nur `counter_pickup` wirkt (Theke/To-go an einem Tisch-Gerät), sonst ergibt er sich aus dem Gerät.',
    enum: OrderFulfillmentType,
  })
  @IsOptional()
  @IsEnum(OrderFulfillmentType)
  fulfillmentType?: OrderFulfillmentType;

  @ApiPropertyOptional({
    type: [CreateOrderItemDto],
    description: 'Liste der Bestellpositionen',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items?: CreateOrderItemDto[];

  @ApiPropertyOptional({
    example: 3.0,
    description: 'Rabattbetrag in EUR (z. B. aus Rabatt-Bons)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discountAmount?: number;

  @ApiPropertyOptional({
    example: 1.0,
    description: 'Trinkgeld in EUR (z. B. bei Kartenzahlung)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  tipAmount?: number;

  @ApiPropertyOptional({
    example: 'Künstler-Bon 3 €',
    description: 'Grund/Bezeichnung des Rabatts',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  discountReason?: string;
}
