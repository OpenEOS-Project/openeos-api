import { IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class StartSessionDto {
  @ApiProperty({ example: 'ABC123', description: 'QR-Code oder Sitzungscode' })
  @IsString()
  @MaxLength(20)
  code: string;
}
