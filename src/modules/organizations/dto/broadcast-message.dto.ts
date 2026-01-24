import { IsString, IsEnum, IsOptional, IsNumber, Min, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BroadcastMessageDto {
  @ApiProperty({ description: 'The message to broadcast' })
  @IsString()
  @MaxLength(500)
  message: string;

  @ApiPropertyOptional({ description: 'Optional title for the message' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string;

  @ApiProperty({
    description: 'Type of message',
    enum: ['info', 'warning', 'success', 'error'],
    default: 'info'
  })
  @IsEnum(['info', 'warning', 'success', 'error'])
  type: 'info' | 'warning' | 'success' | 'error' = 'info';

  @ApiPropertyOptional({
    description: 'Duration to show the message in milliseconds. 0 = persistent until dismissed.',
    default: 10000
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  duration?: number = 10000;
}
