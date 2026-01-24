import { IsString, IsEmail, IsOptional, IsArray, IsUUID, MaxLength, ArrayMinSize } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PublicRegisterDto {
  @ApiProperty({ description: 'Name of the helper', example: 'Max Mustermann' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ description: 'Email address for verification', example: 'max@example.com' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ description: 'Phone number (optional)', example: '+49 123 4567890' })
  @IsString()
  @MaxLength(50)
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ description: 'Notes or comments from the helper' })
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  notes?: string;

  @ApiProperty({ description: 'List of shift IDs to register for', type: [String] })
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMinSize(1)
  shiftIds: string[];
}
