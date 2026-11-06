import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { QueryOrdersDto } from './query-orders.dto';

/** Aufbau der CSV-Datei. */
export enum OrdersExportVariant {
  /** Eine Zeile je Bestellung (Summen, Zahlart, Status). */
  ORDERS = 'orders',
  /** Eine Zeile je Bestellposition (Produkt, Menge, Preis, Steuersatz). */
  ITEMS = 'items',
}

/**
 * Filter wie die Bestellliste (`GET …/orders`), ohne Seiten: exportiert
 * wird alles, was zu den Filtern passt.
 */
export class ExportOrdersDto extends OmitType(QueryOrdersDto, [
  'page',
  'limit',
  'includeItems',
] as const) {
  @ApiPropertyOptional({
    enum: OrdersExportVariant,
    default: OrdersExportVariant.ORDERS,
    description:
      '`orders`: eine Zeile je Bestellung; `items`: eine Zeile je Position',
  })
  @IsOptional()
  @IsEnum(OrdersExportVariant)
  variant?: OrdersExportVariant;
}
