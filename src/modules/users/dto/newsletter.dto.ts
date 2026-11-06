import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateNewsletterDto {
  @ApiProperty({
    description: 'true = Einwilligung erteilen, false = widerrufen',
  })
  @IsBoolean()
  subscribed: boolean;
}

export class NewsletterUnsubscribeDto {
  @ApiPropertyOptional({
    description:
      'Token aus dem Abmeldelink (alternativ als Query-Parameter `token`)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  token?: string;

  /** RFC 8058: Mailprogramme senden `List-Unsubscribe=One-Click`. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  'List-Unsubscribe'?: string;
}
