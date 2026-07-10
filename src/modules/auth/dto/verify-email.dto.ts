import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class VerifyEmailDto {
  @ApiProperty({
    example: 'a1b2c3d4e5f6...',
    description: 'Bestätigungs-Token aus der E-Mail',
  })
  @IsString()
  token: string;
}
