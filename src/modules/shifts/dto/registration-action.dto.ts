import { IsString, IsOptional, MaxLength, IsArray } from 'class-validator';
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

export class BroadcastMessageDto {
  @ApiPropertyOptional({
    description:
      'Message template. Supports placeholders {{name}}, {{plan}} and {{schichten}}/{{shifts}} (the helper\'s registered shifts).',
  })
  @IsString()
  @MaxLength(5000)
  message: string;

  @ApiPropertyOptional({ description: 'Optional subject line' })
  @IsString()
  @MaxLength(200)
  @IsOptional()
  subject?: string;

  @ApiPropertyOptional({
    description:
      'Limit delivery to these helper emails (case-insensitive). Omit to send to every helper with an email.',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  recipientEmails?: string[];
}

export class UpdateRegistrationNotesDto {
  @ApiPropertyOptional({ description: 'Internal admin notes' })
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  adminNotes?: string;
}
