import { IsString, IsOptional, IsInt, Min, IsDateString, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateShiftDto {
  @ApiProperty({ description: 'Date of the shift', example: '2024-07-20' })
  @IsDateString()
  date: string;

  @ApiProperty({ description: 'Start time (HH:mm)', example: '14:00' })
  @IsString()
  @Matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: 'Start time must be in HH:mm format' })
  startTime: string;

  @ApiProperty({ description: 'End time (HH:mm)', example: '18:00' })
  @IsString()
  @Matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/, { message: 'End time must be in HH:mm format' })
  endTime: string;

  @ApiPropertyOptional({ description: 'Number of workers needed', default: 1 })
  @IsInt()
  @Min(1)
  @IsOptional()
  requiredWorkers?: number;

  @ApiPropertyOptional({ description: 'Internal notes (not shown to helpers)' })
  @IsString()
  @IsOptional()
  notes?: string;
}
