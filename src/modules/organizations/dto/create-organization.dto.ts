import { IsString, MinLength, MaxLength, IsOptional, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Musterverein e.V.', description: 'Name der Organisation' })
  @IsString()
  @MinLength(2, { message: 'Name muss mindestens 2 Zeichen lang sein' })
  @MaxLength(200, { message: 'Name darf maximal 200 Zeichen lang sein' })
  name: string;

  @ApiPropertyOptional({ example: { currency: 'EUR', timezone: 'Europe/Berlin' }, description: 'Organisationseinstellungen' })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}
