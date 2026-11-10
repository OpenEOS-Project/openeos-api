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
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentUser } from '../../common/decorators';
import { ClosedOrganizationAccess } from '../../common/organization-closure/organization-closure.guard';
import type { User } from '../../database/entities';
import { TseUnitService } from '../tse/tse-unit.service';
import { CashbookService } from './cashbook.service';
import { CashPointClosingService } from './cash-point-closing.service';
import {
  CashbookQueryDto,
  ChangeVatStatusDto,
  CreateCashbookEntryDto,
  DsfinvkClosingsQueryDto,
  DsfinvkExportQueryDto,
} from './dto/dsfinvk.dto';

function meta(request: Request) {
  return {
    ipAddress: request.ip ?? null,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

/**
 * DSFinV-K (Kassenabschlüsse, Export für Kassen-Nachschau und Prüfung) und
 * Kassenbuch einer Organisation — nur Admins (und Super-Admins).
 */
@ApiTags('DSFinV-K')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:id')
export class DsfinvkController {
  constructor(
    private readonly closings: CashPointClosingService,
    private readonly cashbook: CashbookService,
    private readonly units: TseUnitService,
  ) {}

  @Get('dsfinvk')
  @ApiOperation({
    summary: 'DSFinV-K export as ZIP (admins)',
    description:
      'Export nach DSFinV-K 2.4 für Kassen-Nachschau (§ 146b AO) und Außenprüfung: 20 CSV-Dateien, `index.xml` und `gdpdu-01-09-2004.dtd` als ZIP. Zeitraum nach Geschäftstagen (`from`/`to`, 6–6 Uhr) oder Z-Nummern (`zFrom`/`zTo`). Enthält nur abgeschlossene Tage — für den laufenden Tag vorher `POST …/dsfinvk/closings`. Header `X-Checksum-SHA256`. Fehler: 400 DSFINVK_RANGE_INVALID, 404 DSFINVK_NO_CLOSINGS.',
  })
  @ApiParam({ name: 'id', description: 'ID der Organisation', format: 'uuid' })
  async export(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DsfinvkExportQueryDto,
    @CurrentUser() user: User,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.closings.exportZip(id, user, query, meta(request));
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'X-Checksum-SHA256': file.sha256,
      'Cache-Control': 'no-store',
    });
    return new StreamableFile(file.data, { length: file.data.length });
  }

  @Get('dsfinvk/closings')
  @ApiOperation({
    summary: 'Cash point closings (admins)',
    description:
      'Kassenabschlüsse (Z-Nr., Geschäftstag, Zeitraum, Summen je Geschäftsvorfall/Zahlart/USt, Anzahl, Prüfsummen), neueste zuerst; dazu `open` = Vorgänge, die noch in keinem Abschluss stehen.',
  })
  async listClosings(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DsfinvkClosingsQueryDto,
    @CurrentUser() user: User,
  ) {
    return { data: await this.closings.list(id, user, query) };
  }

  @Post('dsfinvk/closings')
  // Dient dem Export: auch in einer geloeschten Organisation (AGB 10.4).
  @ClosedOrganizationAccess()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a cash point closing now (admins)',
    description:
      'Schließt alle offenen Vorgänge bis jetzt ab (je Geschäftstag ein Abschluss, fortlaufende Z-Nr.). Abschlüsse sind unveränderlich. Fehler: 409 DSFINVK_NOTHING_TO_CLOSE, 409 DSFINVK_PENDING_TRANSACTIONS.',
  })
  async createClosing(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Req() request: Request,
  ) {
    return {
      data: await this.closings.requestClosing(id, user, meta(request)),
    };
  }

  @Post('vat-status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change the VAT status after a cash point closing (admins)',
    description:
      'Kleinunternehmer (`vatExempt: true`) ↔ umsatzsteuerpflichtig (`vatExempt: false`), z. B. „ab sofort umsatzsteuerpflichtig“ beim Überschreiten der Grenzen des § 19 UStG. Schließt vorher alle offenen Vorgänge ab (Kassenabschluss, DSFinV-K Tz. 3), dann Stammdatenwechsel, Protokoll `vat_status_changed`, Verlauf `settings.vatStatusHistory`. Fehler: 409 DSFINVK_PENDING_TRANSACTIONS.',
  })
  async changeVatStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ChangeVatStatusDto,
    @CurrentUser() user: User,
    @Req() request: Request,
  ) {
    return {
      data: await this.closings.changeVatStatus(
        id,
        user,
        body.vatExempt,
        meta(request),
      ),
    };
  }

  @Get('dsfinvk/closings/:closingId/download')
  @ApiOperation({
    summary: 'Download the DSFinV-K export of one closing (admins)',
    description:
      'ZIP des Abschlusses aus dem Archiv (`TSE_EXPORT_DIR/<org>/dsfinvk/`), Header `X-Checksum-SHA256`.',
  })
  async downloadClosing(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('closingId', ParseUUIDPipe) closingId: string,
    @CurrentUser() user: User,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.closings.closingFile(id, closingId, user);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'X-Checksum-SHA256': file.sha256,
      'Cache-Control': 'no-store',
    });
    return new StreamableFile(file.data, { length: file.data.length });
  }

  @Get('cashbook')
  @ApiOperation({
    summary: 'Cash book of a business day (admins)',
    description:
      'Kassenbuch eines Geschäftstags (6–6 Uhr): Buchungen (Anfangsbestand, Einlage, Entnahme, Kassensturz) und Soll-Bestand gesamt und je Gerät (Kassenbuch + Barzahlungen − Bar-Erstattungen − Pfand-Auszahlungen).',
  })
  async cashbookDay(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CashbookQueryDto,
    @CurrentUser() user: User,
  ) {
    await this.units.assertAdmin(id, user);
    return {
      data: await this.cashbook.day(id, query.date, query.deviceId ?? null),
    };
  }

  @Post('cashbook')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Book a cash book entry for the whole register (admins)',
    description:
      'Wie an der Kasse, aber für die ganze Kasse (ohne Gerät). Jede Bargeldbewegung ist ein eigener TSE-gesicherter Beleg. Nur wenn Bargeld erlaubt ist (sonst 403 wie bei Barzahlungen).',
  })
  async createCashbookEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCashbookEntryDto,
    @CurrentUser() user: User,
  ) {
    await this.units.assertAdmin(id, user);
    return { data: await this.cashbook.create(id, dto, { userId: user.id }) };
  }
}
