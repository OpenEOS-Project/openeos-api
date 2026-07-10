import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { SupportService } from './support.service';
import { SendSupportMessageDto } from './dto';
import { SuperAdminGuard } from '../../common/guards/super-admin.guard';

@ApiTags('Admin Support')
@ApiBearerAuth('JWT-auth')
@Controller('admin/support')
@UseGuards(SuperAdminGuard)
export class SupportAdminController {
  constructor(private readonly supportService: SupportService) {}

  @Get('threads')
  async getThreads() {
    const data = await this.supportService.getThreadsForAdmin();
    return { data };
  }

  @Get(':organizationId/messages')
  async getMessages(@Param('organizationId', ParseUUIDPipe) organizationId: string) {
    const data = await this.supportService.getMessagesForAdmin(organizationId);
    return { data };
  }

  @Post(':organizationId/messages')
  async sendMessage(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: SendSupportMessageDto,
  ) {
    const data = await this.supportService.postAdminMessage(organizationId, dto);
    return { data };
  }
}
