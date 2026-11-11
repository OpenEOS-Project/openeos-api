import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
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
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsUUIDLoose } from '../../../common/validators/is-uuid-loose.validator';

export const TOKEN_SALE_METHODS = ['cash', 'card', 'sumup_terminal'] as const;
export type TokenSaleMethod = (typeof TOKEN_SALE_METHODS)[number];

export class TokenLineDto {
  @ApiProperty()
  @IsUUIDLoose()
  tokenTypeId: string;

  @ApiProperty({ example: 10 })
  @IsInt()
  @Min(1)
  @Max(10000)
  count: number;
}

class TokenTransactionBaseDto {
  @ApiPropertyOptional({ description: 'Veranstaltung (Testmodus, Auswertung)' })
  @IsOptional()
  @IsUUIDLoose()
  eventId?: string;

  @ApiProperty({ type: [TokenLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => TokenLineDto)
  lines: TokenLineDto[];

  @ApiPropertyOptional({
    description:
      'Gleiche ID = gleicher Vorgang (Wiederholung nach Netzfehler bucht nicht doppelt)',
  })
  @IsOptional()
  @IsUUIDLoose()
  clientRequestId?: string;
}

/** Verkauf von Wertmarken an der Kasse. */
export class CreateTokenSaleDto extends TokenTransactionBaseDto {
  @ApiProperty({ enum: TOKEN_SALE_METHODS, example: 'cash' })
  @IsIn(TOKEN_SALE_METHODS)
  paymentMethod: TokenSaleMethod;

  @ApiPropertyOptional({
    example: 50,
    description: 'Bar: vom Gast erhalten (Rückgeld auf dem Beleg)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amountReceived?: number;

  @ApiPropertyOptional({
    description: 'SumUp-Transaktion (Karte am Lesegerät)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  providerTransactionId?: string;
}

/** Rücktausch von Wertmarken gegen Bargeld. */
export class CreateTokenBuybackDto extends TokenTransactionBaseDto {
  @ApiPropertyOptional({ example: 'Rücktausch am Ende des Festes' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class PrintTokenTransactionDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  reprint?: boolean;
}

export class TokenReportQueryDto {
  @ApiPropertyOptional({ description: 'Nur diese Veranstaltung' })
  @IsOptional()
  @IsUUIDLoose()
  eventId?: string;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'Ab diesem Tag (Datum der Buchung)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  startDate?: string;

  @ApiPropertyOptional({
    example: '2026-11-30',
    description: 'Bis einschließlich diesem Tag',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  endDate?: string;
}

export class TokenTransactionQueryDto extends TokenReportQueryDto {
  @ApiPropertyOptional({
    enum: ['sale', 'buyback'],
    description: 'Nur Verkauf (`sale`) oder Rücktausch (`buyback`)',
  })
  @IsOptional()
  @IsIn(['sale', 'buyback'])
  kind?: 'sale' | 'buyback';

  @ApiPropertyOptional({
    default: 50,
    description: 'Höchstens so viele (1–200)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
