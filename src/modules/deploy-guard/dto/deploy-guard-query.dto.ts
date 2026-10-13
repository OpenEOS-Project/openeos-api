import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class DeployGuardQueryDto {
  @ApiPropertyOptional({
    description: 'Look-back window for real orders, in minutes',
    default: 30,
    minimum: 1,
    maximum: 1440,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  windowMinutes?: number;
}
