import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '../../database/entities';
import { AccountDeletionService } from './account-deletion.service';
import { DeleteAccountDto } from './dto';
import { formatDate } from './retention-mails';

/**
 * „Konto löschen“ in den Kontoeinstellungen (Loeschkonzept 5.1). Erst
 * `GET` (was passiert, was sperrt), bei Konten ohne Passwort `POST code`,
 * dann `POST` mit Passwort bzw. Code. Danach ist der Benutzer abgemeldet —
 * ausser es gehen Organisationen mit: dann ist die Loeschung geplant
 * (`scheduled`), der Benutzer bleibt bis zum Termin angemeldet und kann sie
 * mit `POST cancel` abbrechen.
 */
@ApiTags('Users')
@ApiBearerAuth('JWT-auth')
@Controller('users/me/deletion')
export class AccountDeletionController {
  constructor(
    private readonly deletion: AccountDeletionService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'What deleting the own account would do (blocking organizations, organizations closed with it, confirmation method)',
  })
  async status(@CurrentUser() user: User) {
    return { data: await this.deletion.status(user.id) };
  }

  @Post('code')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @ApiOperation({ summary: 'Send a confirmation code by e-mail' })
  async sendCode(@CurrentUser() user: User) {
    await this.deletion.sendCode(user.id);
    return { message: 'Code wurde gesendet' };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 900000 } })
  @ApiOperation({
    summary:
      'Delete (anonymise) the own account after confirming with password or e-mail code; logs out',
  })
  async delete(
    @CurrentUser() user: User,
    @Body() dto: DeleteAccountDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { run, scheduled } = await this.deletion.deleteAccount(user.id, dto);
    if (scheduled) {
      return {
        data: {
          deleted: false,
          scheduled: true,
          dueAt: scheduled.dueAt,
          organizations: scheduled.organizations,
          runId: run.id,
        },
        message: `Dein Konto und ${scheduled.organizations.length > 1 ? 'die Organisationen' : 'die Organisation'} werden am ${formatDate(scheduled.dueAt)} endgültig gelöscht`,
      };
    }
    const cookie = {
      httpOnly: true,
      secure: this.configService.get('nodeEnv') === 'production',
      sameSite: 'lax' as const,
      path: '/',
    };
    response.clearCookie('refreshToken', cookie);
    response.clearCookie('accessToken', cookie);
    return {
      data: { deleted: true, scheduled: false, runId: run.id },
      message: 'Dein Konto wurde gelöscht',
    };
  }

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 900000 } })
  @ApiOperation({
    summary:
      'Cancel a scheduled account deletion (restores the account and the organizations deleted with it, until the final deletion)',
  })
  async cancel(@CurrentUser() user: User) {
    const run = await this.deletion.cancelScheduledDeletion(user.id);
    return {
      data: { cancelled: true, runId: run.id },
      message: 'Die Löschung wurde abgebrochen',
    };
  }
}
