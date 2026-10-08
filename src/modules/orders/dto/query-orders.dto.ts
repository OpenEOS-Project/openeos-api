import {
  IsOptional,
  IsString,
  MaxLength,
  IsUUID,
  IsEnum,
  IsDateString,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  OrderStatus,
  PaymentStatus,
  OrderSource,
  OrderFulfillmentType,
} from '../../../database/entities/order.entity';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class QueryOrdersDto extends PaginationDto {
  // Narrower than PaginationDto's generic cap of 500 — the orders list/stats
  // views are not meant to page through hundreds of rows at once.
  @ApiPropertyOptional({
    example: 50,
    description: 'Anzahl pro Seite (max. 100)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @ApiPropertyOptional({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Filter nach Event-ID',
  })
  @IsOptional()
  @IsUUID()
  eventId?: string;

  @ApiPropertyOptional({
    example: 'open',
    description: 'Filter nach Bestellstatus',
    enum: OrderStatus,
  })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiPropertyOptional({
    example: 'pending',
    description: 'Filter nach Zahlungsstatus',
    enum: PaymentStatus,
  })
  @IsOptional()
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus;

  @ApiPropertyOptional({
    example: 'pos',
    description: 'Filter nach Bestellquelle',
    enum: OrderSource,
  })
  @IsOptional()
  @IsEnum(OrderSource)
  source?: OrderSource;

  @ApiPropertyOptional({
    example: 'counter_pickup',
    description: 'Filter nach Erfüllungstyp',
    enum: OrderFulfillmentType,
  })
  @IsOptional()
  @IsEnum(OrderFulfillmentType)
  fulfillmentType?: OrderFulfillmentType;

  @ApiPropertyOptional({
    example: '2024-01-01T00:00:00.000Z',
    description: 'Startdatum für Filterung',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({
    example: '2024-12-31T23:59:59.000Z',
    description: 'Enddatum für Filterung',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Bestellpositionen einschließen',
  })
  @IsOptional()
  // Accept both the raw query string and an already-coerced boolean:
  // enableImplicitConversion can turn "true" into boolean true *before* this
  // transform runs, in which case `value === 'true'` would wrongly be false.
  @Transform(({ value }) => value === true || value === 'true')
  includeItems?: boolean;

  @ApiPropertyOptional({
    example: 'Burger',
    description: 'Suche: Bestell-/Tagesnummer, Tisch, Name oder Produkt',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    example: 'unpaid,refunded',
    description:
      'Status wie in der Kasse (kommagetrennt): in_kitchen, ready, completed, unpaid, cancelled, partly_refunded, refunded',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayStatus?: string;

  @ApiPropertyOptional({
    example: 'cash,sumup',
    description: 'Zahlart (kommagetrennt): cash, card, sumup, discount',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  paymentMethod?: string;

  @ApiPropertyOptional({ description: 'Nur Bestellungen dieses Geräts' })
  @IsOptional()
  @IsUUID()
  deviceId?: string;
}
