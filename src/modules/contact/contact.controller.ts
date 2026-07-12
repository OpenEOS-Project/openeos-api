import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { ContactService } from './contact.service';
import { CreateContactRequestDto } from './dto';

@ApiTags('Contact')
@Controller('public/contact')
@Public()
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  @Post()
  @Throttle({ default: { limit: 5, ttl: 3600000 } })
  @ApiOperation({ summary: 'Demo-/Kontaktanfrage von der Marketing-Website (nicht authentifiziert)' })
  async submit(@Body() dto: CreateContactRequestDto) {
    const data = await this.contactService.submit(dto);
    return { data };
  }
}
