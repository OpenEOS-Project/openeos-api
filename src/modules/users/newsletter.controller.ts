import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, Public } from '../../common/decorators';
import type { User } from '../../database/entities';
import { NewsletterUnsubscribeDto, UpdateNewsletterDto } from './dto';
import { NewsletterService } from './newsletter.service';

@ApiTags('Users')
@ApiBearerAuth('JWT-auth')
@Controller('users/me/newsletter')
export class NewsletterController {
  constructor(private readonly newsletter: NewsletterService) {}

  @Get()
  @ApiOperation({ summary: 'Newsletter consent of the current user' })
  async get(@CurrentUser() user: User) {
    return { data: await this.newsletter.get(user.id) };
  }

  @Put()
  @ApiOperation({
    summary:
      'Give or withdraw the newsletter consent (both timestamps are kept as proof)',
  })
  async set(@CurrentUser() user: User, @Body() dto: UpdateNewsletterDto) {
    return { data: await this.newsletter.set(user.id, dto.subscribed) };
  }
}

/**
 * Abmeldelink aus Newsletter-Mails (auch RFC 8058 „One-Click“: POST an
 * dieselbe Adresse mit dem Token als Query-Parameter).
 */
@ApiTags('Public')
@Controller('public/newsletter')
export class NewsletterPublicController {
  constructor(private readonly newsletter: NewsletterService) {}

  @Public()
  @Post('unsubscribe')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiOperation({ summary: 'Withdraw the newsletter consent via signed link' })
  @ApiQuery({
    name: 'token',
    required: false,
    type: String,
    description: 'Token aus dem Abmeldelink (RFC 8058 One-Click)',
  })
  async unsubscribe(
    @Body() dto: NewsletterUnsubscribeDto,
    @Query('token') queryToken?: unknown,
  ) {
    await this.newsletter.unsubscribe(dto?.token ?? queryToken);
    return {
      data: { unsubscribed: true },
      message: 'Du bekommst keine Neuigkeiten mehr per E-Mail.',
    };
  }
}
