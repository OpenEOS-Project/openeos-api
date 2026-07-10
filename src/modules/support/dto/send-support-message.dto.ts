import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SendSupportMessageDto {
  @ApiProperty({ example: 'Wie kann ich einen Drucker hinzufügen?', description: 'Nachrichtentext' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body: string;
}
