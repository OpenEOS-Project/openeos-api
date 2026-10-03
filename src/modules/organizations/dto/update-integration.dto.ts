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
