import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, Matches, Max, Min } from 'class-validator';

/** `POST /device-api/sumup/checkout`: Betrag fuer den Kartenleser. */
export class DeviceSumupCheckoutDto {
  @ApiProperty({ example: 12.5, description: 'Betrag in Euro, größer als 0' })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(100_000)
  amount: number;

  @ApiPropertyOptional({ example: 'EUR', description: 'ISO-4217-Code' })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;
}
