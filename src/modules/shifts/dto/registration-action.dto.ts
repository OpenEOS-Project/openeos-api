import { IsString, IsOptional, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ApproveRegistrationDto {
  @ApiPropertyOptional({ description: 'Optional message to include in confirmation email' })
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  message?: string;
}

export class RejectRegistrationDto {
  @ApiPropertyOptional({ description: 'Reason for rejection (shown to helper)' })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  reason?: string;
}

export class SendMessageDto {
  @ApiPropertyOptional({ description: 'Message to send to the helper' })
  @IsString()
  @MaxLength(2000)
  message: string;
}

export class UpdateRegistrationNotesDto {
  @ApiPropertyOptional({ description: 'Internal admin notes' })
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  adminNotes?: string;
}
