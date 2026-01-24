import { IsString, MinLength, MaxLength, IsOptional, IsObject, IsBoolean } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ example: 'Musterverein e.V.', description: 'Name der Organisation' })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Name muss mindestens 2 Zeichen lang sein' })
  @MaxLength(200, { message: 'Name darf maximal 200 Zeichen lang sein' })
  name?: string;

  @ApiPropertyOptional({ example: 'https://example.com/logo.png', description: 'URL des Organisationslogos' })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Logo-URL darf maximal 500 Zeichen lang sein' })
  logoUrl?: string;

  @ApiPropertyOptional({ example: { currency: 'EUR', timezone: 'Europe/Berlin' }, description: 'Organisationseinstellungen' })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;

  @ApiPropertyOptional({ example: true, description: 'Gibt an, ob die Organisation aktiv ist' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
