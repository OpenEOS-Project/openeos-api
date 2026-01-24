import { IsString, IsOptional, IsInt, Min, MaxLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateShiftJobDto {
  @ApiProperty({ description: 'Name of the job', example: 'Zapfen' })
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ description: 'Description of what this job involves' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Color code for UI display', example: '#3b82f6' })
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'Color must be a valid hex color code' })
  @IsOptional()
  color?: string;

  @ApiPropertyOptional({ description: 'Sort order (lower = first)', default: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;
}
