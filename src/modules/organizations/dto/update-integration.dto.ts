import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateIntegrationDto {
  @ApiProperty({
    example: true,
    description: 'Integration für die Organisation ein- oder ausschalten',
  })
  @IsBoolean()
  enabled: boolean;
}

export class UpdateCashlessDto {
  @ApiProperty({
    example: true,
    description:
      'Bargeldloser Modus: true sperrt Bargeld an allen Kassen und in der Verwaltung',
  })
  @IsBoolean()
  cashless: boolean;
}
