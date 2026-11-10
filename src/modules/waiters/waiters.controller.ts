import { WaiterCashAuditService } from './waiter-cash-audit.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import {
  BulkCreateWaitersDto,
  CreateWaiterDto,
  ResetWaiterPinDto,
  SettleWaiterDto,
  TipPayoutDto,
  TransferTablesDto,
  UpdateWaiterDto,
} from './dto/waiter.dto';
import { waiterExportCsv } from './waiter-export';
import { WaiterSettlementsService } from './waiter-settlements.service';
import { WaiterTransferService } from './waiter-transfer.service';
import { WaitersService, type RequestMeta } from './waiters.service';

function metaOf(req: Request): RequestMeta {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

/**
 * Bedienungen verwalten (bedienungen-plan.md §5): Admin oder Recht
 * „Bedienungen“. Bewusst ohne API-Token/MCP (keine Personendaten des
 * Kassenpersonals ueber Agenten, Entscheidung 14).
 */
@ApiTags('Waiters')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:id/waiters')
export class WaitersController {
  constructor(
    private readonly waiters: WaitersService,
    private readonly settlements: WaiterSettlementsService,
    private readonly transfers: WaiterTransferService,
    private readonly cashAudit: WaiterCashAuditService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Bedienungen der Organisation (ohne PIN)',
    description:
      '`eventId`: Bedienungen dieser Veranstaltung plus die organisationsweiten. `active=true|false` filtert. `meta.limit`/`meta.count`: Obergrenze (0 = unbegrenzt) und angelegte Bedienungen; Bedienungen zählen nicht zu den Mitgliedern.',
  })
  @ApiQuery({ name: 'eventId', required: false })
  @ApiQuery({ name: 'active', required: false, enum: ['true', 'false'] })
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Query('eventId', new ParseUUIDPipe({ optional: true })) eventId?: string,
    @Query('active') active?: string,
  ) {
    return this.waiters.list(id, user, {
      eventId: eventId ?? null,
      active: active === 'true' ? true : active === 'false' ? false : null,
    });
  }

  @Post()
  @ApiOperation({
    summary: 'Bedienung anlegen',
    description:
      'Ohne `pin` erzeugt das System eine eindeutige PIN (Länge laut `settings.waiters.pinLength`, Standard 4). Die Antwort enthält die PIN **einmalig**; gespeichert wird nur ein Prüfwert. Eigene PIN: einfache Folgen und vergebene PINs → 400 PIN_NOT_AVAILABLE. Obergrenze: 400 WAITER_LIMIT_REACHED.',
  })
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateWaiterDto,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    return { data: await this.waiters.create(id, dto, user, metaOf(req)) };
  }

  @Post('bulk')
  @ApiOperation({
    summary: 'Bedienungen in einem Schritt anlegen (bis 200)',
    description:
      'Namensliste je Veranstaltung (`eventId`) oder organisationsweit. Alle bekommen eine erzeugte PIN; die Antwort enthält sie **einmalig** (PIN-Zettel). Alles oder nichts.',
  })
  async bulk(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BulkCreateWaitersDto,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    return { data: await this.waiters.bulkCreate(id, dto, user, metaOf(req)) };
  }

  @Get(':waiterId')
  @ApiOperation({ summary: 'Eine Bedienung (ohne PIN)' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('waiterId', ParseUUIDPipe) waiterId: string,
    @CurrentUser() user: User,
  ) {
    return { data: await this.waiters.findOne(id, waiterId, user) };
  }

  @Patch(':waiterId')
  @ApiOperation({
    summary: 'Bedienung ändern',
    description:
      'Name, Kurzname, Farbe, Rolle, Rechte, Veranstaltung, aktiv. Deaktivieren löscht die PIN und beendet offene Sitzungen (Kasse sperrt).',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('waiterId', ParseUUIDPipe) waiterId: string,
    @Body() dto: UpdateWaiterDto,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    return {
      data: await this.waiters.update(id, waiterId, dto, user, metaOf(req)),
    };
  }

  @Post(':waiterId/pin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Neue PIN vergeben',
    description:
      'Erzeugt eine neue PIN (oder setzt die gewählte) und beendet offene Sitzungen. Die Antwort enthält die PIN **einmalig**.',
  })
  async resetPin(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('waiterId', ParseUUIDPipe) waiterId: string,
    @Body() dto: ResetWaiterPinDto,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    return {
      data: await this.waiters.resetPin(
        id,
        waiterId,
        dto.pin,
        user,
        metaOf(req),
      ),
    };
  }

  @Delete(':waiterId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bedienung löschen',
    description:
      'Ohne Buchungen wird sie gelöscht (`deleted: true`). Mit Buchungen wird sie deaktiviert und anonymisiert (`anonymized: true`, Name „Bedienung N“); das Steuerarchiv behält den Namen beim Signieren.',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('waiterId', ParseUUIDPipe) waiterId: string,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    return { data: await this.waiters.remove(id, waiterId, user, metaOf(req)) };
  }

  // ------------------------------------------------------------ Abrechnung

  @Get(':waiterId/summary')
  @ApiOperation({
    summary: 'Zwischenstand einer Bedienung',
    description:
      'Zahlen seit der letzten Abrechnung dieser Bedienung in der Veranstaltung (sonst ab Beginn): kassiert je Zahlart mit Trinkgeld, Storno/Erstattungen, Pfand-Auszahlungen, aufgenommen, Soll bar (informativ, Schublade je Gerät), offene Tische, Training getrennt. In „Nur Bons“ nur Mengen. `eventId` ohne Angabe: Veranstaltung der Bedienung bzw. die laufende.',
  })
  @ApiQuery({ name: 'eventId', required: false })
  async summary(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('waiterId', ParseUUIDPipe) waiterId: string,
    @CurrentUser() user: User,
    @Query('eventId', new ParseUUIDPipe({ optional: true })) eventId?: string,
  ) {
    await this.waiters.assertCanManage(id, user);
    return {
      data: await this.settlements.summary(
        id,
        { kind: 'waiter', waiterId },
        eventId ?? null,
      ),
    };
  }

  @Post(':waiterId/settlements')
  @ApiOperation({
    summary: 'Bedienung abrechnen',
    description:
      'Schließt den Zeitraum seit der letzten Abrechnung ab (unveränderlich, fortlaufende Nummer je Organisation; nur Testbuchungen → Training ohne Nummer). Offene Tische: 409 WAITER_OPEN_TABLES (`params.openTables`) — übergeben oder mit `force` + `note` trotzdem abrechnen. Nichts abzurechnen: 400 WAITER_SETTLEMENT_EMPTY. Mit `printerId` wird der Abrechnungsbon gedruckt.',
  })
  async settle(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('waiterId', ParseUUIDPipe) waiterId: string,
    @Body() dto: SettleWaiterDto,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    await this.waiters.assertCanManage(id, user);
    const result = await this.settlements.settle(
      id,
      { kind: 'waiter', waiterId },
      {
        userId: user.id,
        waiterId: null,
        mayForce: true,
        deviceId: null,
        ...metaOf(req),
      },
      {
        eventId: dto.eventId ?? null,
        countedCash: dto.countedCash ?? null,
        force: dto.force === true,
        note: dto.note ?? null,
        printerId: dto.printerId ?? null,
        print: !!dto.printerId,
      },
    );
    // Kartentrinkgeld gleich mit auszahlen (nur Arbeitnehmer).
    const tipPayout = dto.payOutCardTips
      ? await this.cashAudit.payOut(
          id,
          waiterId,
          { userId: user.id, waiterId: null, deviceId: null },
          {
            eventId: result.settlement.eventId,
            settlementId: result.settlement.id,
            printerId: dto.printerId ?? null,
            print: !!dto.printerId,
          },
        )
      : null;
    return {
      data: result.settlement,
      meta: { printed: result.printed, tipPayout: tipPayout?.payout ?? null },
    };
  }

  @Get(':waiterId/tip-payouts')
  @ApiOperation({
    summary: 'Kartentrinkgeld einer Bedienung',
    description:
      'Arbeitnehmer (Lohnkonto)? Offenes Kartentrinkgeld (unbare Zahlungen dieser Bedienung abzüglich Erstattungen und Auszahlungen) und bisherige Auszahlungen mit TSE-Beleg.',
  })
  async tipPayouts(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('waiterId', ParseUUIDPipe) waiterId: string,
    @CurrentUser() user: User,
  ) {
    await this.waiters.assertCanManage(id, user);
    return { data: await this.cashAudit.tipPayoutStatus(id, waiterId) };
  }

  @Post(':waiterId/tip-payouts')
  @ApiOperation({
    summary: 'Kartentrinkgeld bar auszahlen',
    description:
      'Nur für Bedienungen mit „Arbeitnehmer (Lohnkonto)“ (sonst 409 TIP_PAYOUT_NOT_EMPLOYEE: bei Ehrenamtlichen gehört das Trinkgeld dem Verein). Eigener Kassenbeleg TrinkgeldAN −x / Bar −x (Cloud-TSE), Empfänger, Quittung mit Unterschrift; mindert den Soll-Bestand. Bargeld muss erlaubt sein. Betrag höchstens das offene Kartentrinkgeld (400 TIP_PAYOUT_AMOUNT_INVALID).',
  })
  async payOutTips(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('waiterId', ParseUUIDPipe) waiterId: string,
    @Body() dto: TipPayoutDto,
    @CurrentUser() user: User,
  ) {
    await this.waiters.assertCanManage(id, user);
    const result = await this.cashAudit.payOut(
      id,
      waiterId,
      { userId: user.id, waiterId: null, deviceId: null },
      {
        amount: dto.amount ?? null,
        eventId: dto.eventId ?? null,
        note: dto.note ?? null,
        printerId: dto.printerId ?? null,
        print: !!dto.printerId,
      },
    );
    return { data: result.payout, meta: { printed: result.printed } };
  }

  @Post(':waiterId/transfer-tables')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Offene Tische einer Bedienung übergeben',
    description:
      'Alle offenen Bestellungen der Bedienung (optional nur einer Veranstaltung) bekommen eine neue verantwortliche Bedienung. Jede Übergabe steht im Bestellverlauf; die Kassen bekommen `orderTransferred`.',
  })
  async transferTables(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('waiterId', ParseUUIDPipe) waiterId: string,
    @Body() dto: TransferTablesDto,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    await this.waiters.assertCanManage(id, user);
    return {
      data: await this.transfers.transferAllOpen(
        id,
        waiterId,
        dto.toWaiterId,
        { admin: true, userId: user.id, ...metaOf(req) },
        dto.eventId ?? null,
      ),
    };
  }

  @Get(':waiterId/export')
  @ApiOperation({
    summary: 'Auskunft über eine Bedienung (Art. 15 DSGVO)',
    description:
      'Stammdaten (ohne PIN), Anmeldungen an Geräten, Abrechnungen und Anzahl der zugeordneten Buchungen. `format=csv` (Standard) oder `json`.',
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'json'] })
  async exportWaiter(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('waiterId', ParseUUIDPipe) waiterId: string,
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('format') format?: string,
  ) {
    const data = await this.waiters.exportData(id, waiterId, user, metaOf(req));
    const base = `bedienung-${waiterId.slice(0, 8)}-auskunft`;
    if (format === 'json') {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${base}.json"`,
      );
      return { data };
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    res.send(waiterExportCsv(data));
  }
}
