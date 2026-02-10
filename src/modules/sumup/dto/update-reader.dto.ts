import { IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateReaderDto {
  @ApiProperty({ example: 'Kartenleser Bar', description: 'New name for the reader' })
  @IsString()
  @MaxLength(255)
  name: string;
}
