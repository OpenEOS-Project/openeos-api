import { IsString, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PairReaderDto {
  @ApiProperty({ example: 'abc123', description: 'SumUp reader pairing code' })
  @IsString()
  @MaxLength(50)
  pairingCode: string;

  @ApiPropertyOptional({ example: 'Kartenleser Bar', description: 'Name for the reader' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;
}
