import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '../../database/entities';
import { LegalElsterService } from './legal-elster.service';

@ApiTags('Legal')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:id/legal')
export class LegalElsterController {
  constructor(private readonly elster: LegalElsterService) {}

  @Get('elster')
  @ApiOperation({
    summary: 'Data for the tax office notification (ELSTER, admins)',
    description:
      'Angaben für die Mitteilung nach § 146a Abs. 4 AO: Software, Hersteller, Version, Seriennummer der Kasse (`OEOS-…`), Betriebsstätte, Steuernummer und je Cloud-TSE Seriennummer, Zertifizierungs-ID, Zertifikat, Inbetriebnahme und Außerbetriebnahme.',
  })
  @ApiParam({ name: 'id', description: 'ID der Organisation', format: 'uuid' })
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return { data: await this.elster.elster(id, user) };
  }
}
