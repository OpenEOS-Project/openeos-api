import { IsString, IsUrl, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCheckoutDto {
  @ApiProperty({ example: 'uuid', description: 'Credit package ID' })
  @IsUUID()
  packageId: string;

  @ApiProperty({ example: 'https://example.com/success', description: 'Success redirect URL' })
  @IsString()
  @IsUrl()
  successUrl: string;

  @ApiProperty({ example: 'https://example.com/cancel', description: 'Cancel redirect URL' })
  @IsString()
  @IsUrl()
  cancelUrl: string;
}

export class CreatePortalSessionDto {
  @ApiProperty({ example: 'https://example.com/billing', description: 'Return URL' })
  @IsString()
  @IsUrl()
  returnUrl: string;
}
