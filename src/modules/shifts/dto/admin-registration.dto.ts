import { IsString, IsEmail, IsOptional, IsBoolean, IsUUID, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AdminCreateRegistrationDto {
  @ApiProperty({ description: 'Helper name', example: 'Max Mustermann' })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiProperty({ description: 'Helper email — used for notifications', example: 'max@example.com' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ description: 'Phone number' })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ description: 'Helper-side notes (visible to admin too)' })
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({ description: 'Admin-only notes' })
  @IsString()
  @IsOptional()
  adminNotes?: string;

  @ApiPropertyOptional({
    description: 'When true, send a confirmation email to the helper. Default false (silent admin add).',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  notify?: boolean;

  @ApiPropertyOptional({
    description:
      'Append the new registration to an existing helper-group. When omitted, ' +
      'a fresh group ID is created (= a new standalone helper).',
  })
  @IsUUID()
  @IsOptional()
  registrationGroupId?: string;
}

export class AdminUpdateRegistrationDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  adminNotes?: string;

  @ApiPropertyOptional({
    description: 'Move the registration to a different shift. The helper will be notified by default unless `notify` is false.',
  })
  @IsUUID()
  @IsOptional()
  shiftId?: string;

  @ApiPropertyOptional({
    description: 'Optional note included in the change-notification email.',
  })
  @IsString()
  @IsOptional()
  notifyMessage?: string;

  @ApiPropertyOptional({
    description: 'When true and the shift is moved, send the helper an update email. Default true.',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  notify?: boolean;
}
