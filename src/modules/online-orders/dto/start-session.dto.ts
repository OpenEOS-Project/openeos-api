import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsUUID, MaxLength } from 'class-validator';

export class StartSessionDto {
  @ApiPropertyOptional({ example: 'ABC123', description: 'QR-Code (optional)' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;

  @ApiPropertyOptional({ description: 'Event ID for direct ordering' })
  @IsOptional()
  @IsUUID()
  eventId?: string;

  @ApiPropertyOptional({ description: 'Organization ID for direct ordering' })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ example: '5', description: 'Table number' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tableNumber?: string;
}
