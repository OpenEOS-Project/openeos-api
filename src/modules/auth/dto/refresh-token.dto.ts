import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';

export class RefreshTokenDto {
  @ApiPropertyOptional({
    example: 'a1b2c3d4e5f6...',
    description: 'Refresh-Token (optional, alternativ aus Cookie)',
  })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
