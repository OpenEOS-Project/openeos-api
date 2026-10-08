import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUIDLoose } from '../../../common/validators/is-uuid-loose.validator';
import {
  REFUND_REASON_CODES,
  type RefundReasonCode,
} from '../../../database/entities/refund.entity';

export class RefundItemSelectionDto {
  @ApiProperty({ description: 'Position der Bestellung' })
  @IsUUIDLoose()
  orderItemId: string;

  @ApiProperty({
    example: 1,
    description: 'Menge (höchstens die offene Menge)',
  })
  @IsInt()
  @Min(1)
  quantity: number;
}

/** Wer die Aktion an der Kasse ausloest (Berechtigung „PIN“). */
export class DeviceActorDto {
  @ApiPropertyOptional({
    example: '1234',
    description:
      'PIN eines Mitglieds mit Recht „Bestellungen“ (oder Admin). Pflicht, wenn das Gerät „Stornieren & Erstatten“ nur mit PIN erlaubt.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4,8}$/)
  pin?: string;

  @ApiPropertyOptional({
    description:
      'An der Kasse angemeldetes Mitglied (nur zur Zuordnung im Verlauf, ohne PIN nicht geprüft)',
  })
  @IsOptional()
  @IsUUIDLoose()
  operatorUserId?: string;
}

export class CancelItemsDto extends DeviceActorDto {
  @ApiProperty({ type: [RefundItemSelectionDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RefundItemSelectionDto)
  items: RefundItemSelectionDto[];

  @ApiPropertyOptional({ enum: REFUND_REASON_CODES })
  @IsOptional()
  @IsIn(REFUND_REASON_CODES)
  reasonCode?: RefundReasonCode;

  @ApiPropertyOptional({ example: 'Gast hat es sich anders überlegt' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reasonText?: string;

  @ApiPropertyOptional({
    description:
      'Bestätigung „Küche hat schon begonnen – trotzdem stornieren?“ für Positionen in Arbeit/fertig (Ausschuss, kein Bestand zurück). Ohne: 409 ORDER_ITEM_ALREADY_STARTED.',
  })
  @IsOptional()
  @IsBoolean()
  confirmStarted?: boolean;
}

export const REFUND_MODES = ['items', 'amount', 'full'] as const;
export type RefundMode = (typeof REFUND_MODES)[number];

export class CreateRefundDto extends DeviceActorDto {
  @ApiProperty({
    enum: REFUND_MODES,
    description:
      '`items`: Positionen/Mengen, `amount`: freier Betrag, `full`: alles noch Erstattbare (mit `cancelItems` = Storno der ganzen Bestellung)',
  })
  @IsIn(REFUND_MODES)
  mode: RefundMode;

  @ApiPropertyOptional({ type: [RefundItemSelectionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RefundItemSelectionDto)
  items?: RefundItemSelectionDto[];

  @ApiPropertyOptional({
    example: 4.5,
    description: 'Nur bei `amount`, in Euro',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount?: number;

  @ApiPropertyOptional({
    description:
      'Positionen zugleich stornieren (Küche/Station nehmen sie heraus). Ohne bleibt es eine Erstattung ohne Storno.',
  })
  @IsOptional()
  @IsBoolean()
  cancelItems?: boolean;

  @ApiPropertyOptional({
    description: 'Bei `items`: Pfand mit erstatten (Standard ja)',
  })
  @IsOptional()
  @IsBoolean()
  includeDeposit?: boolean;

  @ApiPropertyOptional({
    description:
      'Zahlung, über die erstattet wird. Ohne: von der jüngsten Zahlung rückwärts.',
  })
  @IsOptional()
  @IsUUIDLoose()
  paymentId?: string;

  @ApiProperty({ enum: REFUND_REASON_CODES })
  @IsIn(REFUND_REASON_CODES)
  reasonCode: RefundReasonCode;

  @ApiPropertyOptional({ example: 'Burger kalt' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reasonText?: string;

  @ApiPropertyOptional({
    description:
      'Wie bei cancel-items: Storno von Positionen in Arbeit bestätigen',
  })
  @IsOptional()
  @IsBoolean()
  confirmStarted?: boolean;

  @ApiPropertyOptional({
    description:
      'Nicht beim Anbieter erstatten, sondern als „manuell erstattet“ buchen (z. B. nach SumUp-Fehler)',
  })
  @IsOptional()
  @IsBoolean()
  manual?: boolean;

  @ApiPropertyOptional({
    description:
      'Je Versuch vergebene UUID; eine Wiederholung liefert dieselbe Erstattung',
  })
  @IsOptional()
  @IsUUIDLoose()
  clientRequestId?: string;
}

export class CancelOrderWithActorDto extends DeviceActorDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;

  @ApiPropertyOptional({ enum: REFUND_REASON_CODES })
  @IsOptional()
  @IsIn(REFUND_REASON_CODES)
  reasonCode?: RefundReasonCode;
}

export class ReprintDto extends DeviceActorDto {
  @ApiPropertyOptional({ enum: ['tickets', 'receipt'] })
  @IsOptional()
  @IsIn(['tickets', 'receipt'])
  type?: 'tickets' | 'receipt';
}

export const HISTORY_PAYMENT_FILTERS = [
  'cash',
  'card',
  'sumup',
  'discount',
] as const;
export type HistoryPaymentFilter = (typeof HISTORY_PAYMENT_FILTERS)[number];
