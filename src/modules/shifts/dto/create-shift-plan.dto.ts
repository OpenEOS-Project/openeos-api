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

  @ApiPropertyOptional({ description: 'Whether the cron sends verification reminders for pending_email helpers', default: true })
  @IsBoolean()
  @IsOptional()
  verificationReminderEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Hours between two verification reminders', default: 24 })
  @IsInt()
  @Min(1)
  @Max(168)
  @IsOptional()
  verificationReminderIntervalHours?: number;

  @ApiPropertyOptional({ description: 'Max number of verification reminders per helper-group', default: 5 })
  @IsInt()
  @Min(0)
  @Max(20)
  @IsOptional()
  verificationReminderMaxCount?: number;
}
