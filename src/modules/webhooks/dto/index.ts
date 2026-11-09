import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { WEBHOOK_DELIVERY_STATUSES } from '../../../database/entities/webhook-delivery.entity';
import { WEBHOOK_EVENT_TYPES } from '../webhook-event-types';

export class CreateWebhookDto {
  @ApiProperty({
    example: 'https://example.org/openeos/webhook',
    description:
      'Ziel der Zustellungen. Nur `https://`, ohne Zugangsdaten in der Adresse; der Name muss sich auf öffentliche Adressen auflösen lassen.',
    maxLength: 2048,
  })
  @IsString()
  @Length(1, 2048)
  url: string;

  @ApiPropertyOptional({
    example: 'Buchhaltung',
    description: 'Wofür der Webhook gedacht ist',
    maxLength: 255,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(255)
  description?: string | null;

  @ApiProperty({
    example: ['order.paid', 'refund.created'],
    enum: WEBHOOK_EVENT_TYPES,
    isArray: true,
    description: 'Abonnierte Ereignisse (mindestens eines)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  eventTypes: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      '„Gästedaten mitsenden“: Name, Telefon und Notizen der Gäste in Bestellungen. Nur einschalten, wenn der Empfänger sie braucht.',
  })
  @IsOptional()
  @IsBoolean()
  includeGuestData?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      '„Testbestellungen mitsenden“ (Testmodus und Phase „Geplant“); sie tragen dann `isTest: true`.',
  })
  @IsOptional()
  @IsBoolean()
  includeTestOrders?: boolean;
}

export class UpdateWebhookDto {
  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsString()
  @Length(1, 2048)
  url?: string;

  @ApiPropertyOptional({ maxLength: 255, nullable: true })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(255)
  description?: string | null;

  @ApiPropertyOptional({ enum: WEBHOOK_EVENT_TYPES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  eventTypes?: string[];

  @ApiPropertyOptional({
    description:
      'Ein- oder ausschalten. Einschalten setzt eine automatische Abschaltung und die Fehlerserie zurück.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includeGuestData?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includeTestOrders?: boolean;
}

export class ListWebhookDeliveriesDto {
  @ApiPropertyOptional({
    description: 'Seite, beginnend bei 1',
    minimum: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: 'Einträge je Seite (höchstens 100)',
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    enum: WEBHOOK_DELIVERY_STATUSES,
    description: 'Nur Zustellungen in diesem Zustand',
  })
  @IsOptional()
  @IsIn(WEBHOOK_DELIVERY_STATUSES)
  status?: (typeof WEBHOOK_DELIVERY_STATUSES)[number];

  @ApiPropertyOptional({
    example: 'order.paid',
    description: 'Nur Zustellungen dieses Ereignisses (auch `ping`)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  eventType?: string;
}
