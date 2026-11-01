import {
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
  IsObject,
  IsIn,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { COUNTRY_CODES } from '../../../common/constants/countries';
import { COUNTRY_MESSAGE, toCountryCode } from './cash-policy.dto';

export class CreateOrganizationDto {
  @ApiProperty({
    example: 'Musterverein e.V.',
    description: 'Name der Organisation',
  })
  @IsString()
  @MinLength(2, { message: 'Name muss mindestens 2 Zeichen lang sein' })
  @MaxLength(200, { message: 'Name darf maximal 200 Zeichen lang sein' })
  name: string;

  @ApiProperty({
    example: 'DE',
    description:
      'Land der Organisation (ISO 3166-1 alpha-2), Pflicht. Steuert die Bargeld-Regel (in Deutschland ohne TSE kein Bargeld) und die Steuersätze; ändern kann es danach nur der Support.',
  })
  @Transform(toCountryCode)
  @IsIn(COUNTRY_CODES, { message: COUNTRY_MESSAGE })
  country: string;

  @ApiPropertyOptional({
    example: { currency: 'EUR', timezone: 'Europe/Berlin' },
    description: 'Organisationseinstellungen',
  })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}
