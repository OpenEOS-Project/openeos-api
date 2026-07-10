import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { SupportService } from './support.service';
import { SendSupportMessageDto } from './dto';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';

@ApiTags('Support')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/support')
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @Get()
  async getThread(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    const data = await this.supportService.getMemberThread(organizationId, user);
    return { data };
  }

  @Post('messages')
  async sendMessage(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: SendSupportMessageDto,
    @CurrentUser() user: User,
  ) {
    const data = await this.supportService.postMemberMessage(organizationId, user, dto);
    return { data };
  }
}
