import { IsNumber, IsString, IsPositive, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class InitiateCheckoutDto {
  @ApiProperty({ example: 12.50, description: 'Payment amount' })
  @IsNumber()
  @IsPositive()
  amount: number;

  @ApiProperty({ example: 'EUR', description: 'Currency code (ISO 4217)' })
  @IsString()
  @MaxLength(3)
  currency: string;
}
