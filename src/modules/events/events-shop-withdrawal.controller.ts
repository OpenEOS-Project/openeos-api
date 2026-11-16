import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import { CreateShopWithdrawalDto } from './dto/shop-withdrawal.dto';
import { ShopWithdrawalService } from './shop-withdrawal.service';

@ApiTags('Shop (Public)')
@Controller('public/shop')
@Public()
export class EventsShopWithdrawalController {
  constructor(private readonly withdrawals: ShopWithdrawalService) {}

  @Get(':eventId/withdrawal')
  @ApiOperation({
    summary: 'Withdrawal function of a shop (§ 356a BGB)',
    description:
      'Veranstaltung, Verein und rechtliche Angaben für die Seite „Vertrag widerrufen“. 404 `WITHDRAWAL_NOT_AVAILABLE`, wenn der Verein kein Widerrufsrecht eingeschaltet hat. Auch nach dem Ende der Veranstaltung erreichbar.',
  })
  async info(@Param('eventId', ParseUUIDPipe) eventId: string) {
    return { data: await this.withdrawals.info(eventId) };
  }

  @Post(':eventId/withdrawal')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 3600000 } })
  @ApiOperation({
    summary: 'Declare the withdrawal from a shop order (§ 356a BGB)',
    description:
      'Name, E-Mail-Adresse und Bestellnummer (Pflicht), weitere Angaben freiwillig. Speichert den Widerruf mit Eingangszeitpunkt, schickt ihn an den Verein und dem Gast sofort eine Eingangsbestätigung mit Inhalt, Datum und Uhrzeit. Höchstens 10 je Stunde und IP-Adresse.',
  })
  async submit(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: CreateShopWithdrawalDto,
  ) {
    return { data: await this.withdrawals.submit(eventId, dto) };
  }
}
