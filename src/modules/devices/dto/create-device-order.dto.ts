import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUIDLoose } from '../../../common/validators/is-uuid-loose.validator';
import { CreateOrderDto } from '../../orders/dto';
import {
  BATCH_MAX_ORDERS,
  BATCH_PAYMENT_METHODS,
  type BatchPaymentMethod,
} from '../../payments/dto/batch-payment.dto';

/**
 * Zahlung, die zusammen mit der Bestellung gebucht wird (eine Transaktion).
 * Felder wie bei `POST /device-api/payments/batch`; die neue Bestellung
 * ist immer die letzte (Trinkgeld, erhaltenes Bargeld).
 */
export class DeviceOrderPaymentDto {
  @ApiProperty({ enum: BATCH_PAYMENT_METHODS, example: 'cash' })
  @IsIn(BATCH_PAYMENT_METHODS)
  paymentMethod: BatchPaymentMethod;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Weitere offene Bestellungen (z. B. Gastbestellungen am Tisch), die in derselben Zahlung beglichen werden. Die neue Bestellung kommt automatisch als letzte dazu.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(BATCH_MAX_ORDERS - 1)
  @ArrayUnique()
  @IsUUIDLoose({ each: true })
  orderIds?: string[];

  @ApiPropertyOptional({
    example: 50,
    description:
      'Bei Barzahlung: insgesamt erhaltener Betrag in Euro (für Rückgeld und Bon)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amountReceived?: number;

  @ApiPropertyOptional({ example: 2, description: 'Trinkgeld in Euro' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  tipAmount?: number;

  @ApiPropertyOptional({
    example: 'TX-12345',
    description: 'Transaktions-ID des Zahlungsanbieters (z. B. SumUp)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  providerTransactionId?: string;

  @ApiPropertyOptional({ example: { terminalId: 'T001' } })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: 4.5,
    description:
      'Rabatt über alle Bestellungen dieser Zahlung (von der letzten rückwärts verteilt). Ohne weitere Bestellungen genügt `discountAmount` der Bestellung.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discountAmount?: number;

  @ApiPropertyOptional({ example: 'Freigetränk' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  discountReason?: string;
}

/**
 * Bestellung der Kasse. Im Kassiermodus `immediate` ist `payment` Pflicht
 * (außer die Bestellung kostet nichts): Bestellung und Zahlung entstehen
 * dann in einer Transaktion, Küchenbon und Stationen erst danach.
 */
export class CreateDeviceOrderDto extends CreateOrderDto {
  @ApiPropertyOptional({
    type: DeviceOrderPaymentDto,
    description:
      'Zahlung gleich mitbuchen (alles oder nichts). Pflicht im Kassiermodus „Sofort kassieren“ (`immediate`), sonst ORDER_PAYMENT_REQUIRED.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceOrderPaymentDto)
  payment?: DeviceOrderPaymentDto;
}
