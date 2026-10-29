import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateAssistantDto {
  @ApiProperty({
    example: true,
    description:
      'Assistent-Funktionen für die Organisation ein- oder ausschalten (Admin)',
  })
  @IsBoolean()
  enabled: boolean;
}
