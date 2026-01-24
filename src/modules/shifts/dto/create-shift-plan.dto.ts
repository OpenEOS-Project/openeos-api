import { IsString, IsOptional, IsUUID, IsBoolean, IsInt, Min, Max, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateShiftPlanDto {
  @ApiProperty({ description: 'Name of the shift plan', example: 'Vereinsfest 2024 Schichtplan' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({ description: 'Description shown to helpers' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Optional linked event ID' })
  @IsUUID()
  @IsOptional()
  eventId?: string;

  @ApiPropertyOptional({ description: 'Custom URL slug (auto-generated if not provided)', example: 'vereinsfest-2024' })
  @IsString()
  @MaxLength(100)
  @IsOptional()
  publicSlug?: string;

  @ApiPropertyOptional({ description: 'Whether registrations require admin approval', default: true })
  @IsBoolean()
  @IsOptional()
  requireApproval?: boolean;

  @ApiPropertyOptional({ description: 'Allow registering for multiple shifts', default: true })
  @IsBoolean()
  @IsOptional()
  allowMultipleShifts?: boolean;

  @ApiPropertyOptional({ description: 'Days before shift to send reminder email', default: 1 })
  @IsInt()
  @Min(0)
  @Max(30)
  @IsOptional()
  reminderDaysBefore?: number;

  @ApiPropertyOptional({ description: 'Max shifts per person (0 = unlimited)' })
  @IsInt()
  @Min(0)
  @IsOptional()
  maxShiftsPerPerson?: number;
}
