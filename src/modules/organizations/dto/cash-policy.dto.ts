import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString } from 'class-validator';
import { COUNTRY_CODES } from '../../../common/constants/countries';

/** Grossbuchstaben ohne Leerraum, damit `de` und ` DE ` gelten. */
export const toCountryCode = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export const COUNTRY_MESSAGE = 'Bitte wähle ein Land aus der Liste.';

/** Land einmalig setzen (Bestandsorganisation ohne Land). */
export class SetOrganizationCountryDto {
  @ApiProperty({
    example: 'DE',
    description: 'Land der Organisation (ISO 3166-1 alpha-2)',
  })
  @Transform(toCountryCode)
  @IsString()
  @IsIn(COUNTRY_CODES, { message: COUNTRY_MESSAGE })
  country: string;
}
