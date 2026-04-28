import { IsString, Matches, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SetPinDto {
  @ApiProperty({ description: 'PIN (4-6 Ziffern)', example: '1234' })
  @IsString()
  @Matches(/^\d{4,6}$/)
  pin: string;
}

export class VerifyPinDto {
  @ApiProperty({ description: 'PIN (4-6 Ziffern)', example: '1234' })
  @IsString()
  @Length(4, 6)
  pin: string;
}
