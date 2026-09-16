import { Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SuperAdminGuard } from '../../common/guards/super-admin.guard';
import { ContactAdminService } from './contact-admin.service';
import type { ContactRequestKind } from '../../database/entities';

/**
 * Durchsicht der Zuschriften von der Website.
 *
 * Bis die Nachrichten abgelegt wurden, gab es hier nichts zu sehen — sie
 * lagen im Postfach dessen, der die Benachrichtigung bekam. Wuensche
 * sammelt man aber, um sie spaeter wieder zu lesen.
 */
@ApiTags('Admin — Zuschriften')
@ApiBearerAuth('JWT-auth')
@Controller('admin/contact-requests')
@UseGuards(SuperAdminGuard)
export class ContactAdminController {
  constructor(private readonly contactAdminService: ContactAdminService) {}

  @Get()
  @ApiOperation({ summary: 'List website enquiries, newest first' })
  async list(
    @Query('type') type?: ContactRequestKind,
    @Query('handled') handled?: string,
  ) {
    return {
      data: await this.contactAdminService.list({
        type,
        // Nur filtern, wenn ausdruecklich gesetzt — sonst alles zeigen.
        handled: handled === undefined ? undefined : handled === 'true',
      }),
    };
  }

  @Patch(':id/handled')
  @ApiOperation({ summary: 'Mark an enquiry as dealt with (toggles)' })
  async toggleHandled(@Param('id') id: string) {
    return { data: await this.contactAdminService.toggleHandled(id) };
  }
}
