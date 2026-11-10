import { WaiterCashAuditService } from './waiter-cash-audit.service';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import { ReprintSettlementDto } from './dto/waiter.dto';
import { WaiterSettlementsService } from './waiter-settlements.service';
import { WaitersService } from './waiters.service';

/**
 * Kellnerabrechnungen ansehen und nachdrucken (Verwaltung): Admin oder
 * Recht „Bedienungen“. Nicht fuer API-Tokens/MCP (Entscheidung 14).
 */
@ApiTags('Waiters')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:id/waiter-settlements')
export class WaiterSettlementsController {
  constructor(
    private readonly waiters: WaitersService,
    private readonly settlements: WaiterSettlementsService,
    private readonly cashAudit: WaiterCashAuditService,
  ) {}

  @Get('live')
  @ApiOperation({
    summary: 'Live-Kassensturz je Bedienung',
    description:
      'Für eine Kassen-Nachschau (§ 146b AO): je Bedienung bzw. Mitglied mit Buchungen seit der letzten Abrechnung in der Veranstaltung (ohne Angabe: die laufende) das Soll bar, wo das Bargeld liegt (Schublade je Gerät), kassiert je Zahlart, Trinkgeld, Erstattungen, Pfand-Auszahlungen, offene Tische und bei Arbeitnehmern das offene Kartentrinkgeld. Zeitpunkt `generatedAt`.',
  })
  @ApiQuery({ name: 'eventId', required: false })
  async live(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Query('eventId', new ParseUUIDPipe({ optional: true })) eventId?: string,
  ) {
    await this.waiters.assertCanManage(id, user);
    return { data: await this.cashAudit.live(id, eventId ?? null) };
  }

  @Get()
  @ApiOperation({
    summary: 'Kellnerabrechnungen',
    description:
      'Neueste zuerst (höchstens 500). Filter `eventId`, `waiterId`. Jede Abrechnung enthält den Schnappschuss der Zahlen (`totals`), offene Tische, „trotz offener Tische“ mit Notiz und wer abgerechnet hat.',
  })
  @ApiQuery({ name: 'eventId', required: false })
  @ApiQuery({ name: 'waiterId', required: false })
  async list(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Query('eventId', new ParseUUIDPipe({ optional: true })) eventId?: string,
    @Query('waiterId', new ParseUUIDPipe({ optional: true }))
    waiterId?: string,
  ) {
    await this.waiters.assertCanManage(id, user);
    return {
      data: await this.settlements.list(id, {
        eventId: eventId ?? null,
        waiterId: waiterId ?? null,
      }),
    };
  }

  @Get(':settlementId')
  @ApiOperation({ summary: 'Eine Kellnerabrechnung' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('settlementId', ParseUUIDPipe) settlementId: string,
    @CurrentUser() user: User,
  ) {
    await this.waiters.assertCanManage(id, user);
    return { data: await this.settlements.findOne(id, settlementId) };
  }

  @Post(':settlementId/reprint')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Abrechnungsbon nachdrucken',
    description:
      'Druckt den Bon „ABRECHNUNG Nr. N“ mit Vermerk „Nachdruck“ auf dem gewählten Drucker (sonst dem Bondrucker des Geräts der Abrechnung). `printed: false`, wenn kein Drucker erreichbar ist.',
  })
  async reprint(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('settlementId', ParseUUIDPipe) settlementId: string,
    @Body() dto: ReprintSettlementDto,
    @CurrentUser() user: User,
  ) {
    await this.waiters.assertCanManage(id, user);
    const printed = await this.settlements.print(
      id,
      settlementId,
      { printerId: dto?.printerId ?? null },
      true,
    );
    return { data: { printed } };
  }
}
