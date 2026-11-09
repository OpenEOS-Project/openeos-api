import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SupportService } from './support.service';
import { EmergencySupportService } from './emergency-support.service';
import { SendSupportMessageDto } from './dto';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';

@ApiTags('Support')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/support')
export class SupportController {
  constructor(
    private readonly supportService: SupportService,
    private readonly emergencySupport: EmergencySupportService,
  ) {}

  @Get()
  async getThread(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    const data = await this.supportService.getMemberThread(
      organizationId,
      user,
    );
    return { data };
  }

  @Get('emergency')
  @ApiOperation({
    summary: 'Emergency support phone for booked event days',
    description:
      'Rufnummer des Notfall-Supports (AGB 18.2) — nur für Mitglieder einer Organisation mit mindestens einer freigeschalteten, noch nicht beendeten Veranstaltung und nur, wenn der Betreiber eine Nummer hinterlegt hat (`OPERATOR_EMERGENCY_PHONE`). Sonst `phone: null`. `eventIds`: Veranstaltungen, für die der Notfall-Support gerade gilt.',
  })
  async getEmergency(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    await this.supportService.checkMembership(organizationId, user.id);
    return {
      data: await this.emergencySupport.forOrganization(organizationId),
    };
  }

  @Post('messages')
  async sendMessage(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: SendSupportMessageDto,
    @CurrentUser() user: User,
  ) {
    const data = await this.supportService.postMemberMessage(
      organizationId,
      user,
      dto,
    );
    return { data };
  }
}
