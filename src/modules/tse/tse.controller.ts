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
import { assertIntegrationEnabled } from '../integrations/integration-catalog';
import {
  CreateTseDto,
  DeactivateTseDto,
  QueryTseTransactionsDto,
  TseExportBundleQueryDto,
} from './dto/tse.dto';
import { businessDayRange } from '../dsfinvk/dsfinvk-master';
import { TseExportService } from './tse-export.service';
import { TseSigningService } from './tse-signing.service';
import { TseStatusService, unitView } from './tse-status.service';
import { TseUnitService } from './tse-unit.service';

function meta(request: Request) {
  return {
    ipAddress: request.ip ?? null,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

/**
 * Cloud-TSE einer Organisation (Integration `tse`, tse-swissbit-plan.md §8).
 * Nur Admins der Organisation (und Super-Admins). Lesen geht immer, alles
 * Schreibende nur mit eingeschalteter Integration.
 */
@ApiTags('Cloud-TSE')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:id/tse')
export class TseController {
  constructor(
    private readonly units: TseUnitService,
    private readonly status: TseStatusService,
    private readonly exports: TseExportService,
    private readonly signing: TseSigningService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Cloud-TSE status (admins)',
    description:
      'Zustand der Cloud-TSE: Verfügbarkeit auf diesem Server (`available`; feiner `availability`: `available`, `coming_soon` = gehostet und angekündigt über `TSE_COMING_SOON`, `not_configured`), Integration, Voraussetzungen (`eligibility`: bezahlte Veranstaltung, Monat), TSE (`unit`), Live-Status von Swissbit (Speicher, Signaturen im Monat, Produkt, Zertifikat; 60 s zwischengespeichert), offener Ausfall, Zähler der letzten 30 Tage, Exporte und Verlauf aller TSEs.',
  })
  @ApiParam({ name: 'id', description: 'ID der Organisation', format: 'uuid' })
  async getStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return { data: await this.status.status(id, user) };
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Create the Cloud-TSE (admins, asynchronous)',
    description:
      'Legt die Cloud-TSE an (nur Deutschland, Integration `tse` eingeschaltet, bezahlte Veranstaltung, frühestens im Monat ihres Beginns). Idempotent: eine laufende TSE kommt zurück. Die Anlage läuft im Hintergrund weiter (`state`: `creating` → `active`). Fehler: 503 TSE_NOT_AVAILABLE, 400 TSE_COUNTRY_NOT_SUPPORTED, 403 INTEGRATION_DISABLED, 409 TSE_REQUIRES_PAID_EVENT, 409 TSE_TOO_EARLY (`params.availableFrom`). Super-Admins können mit `override` + `reason` übersteuern.',
  })
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTseDto,
    @CurrentUser() user: User,
    @Req() request: Request,
  ) {
    const unit = await this.units.requestCreation(id, user, dto, meta(request));
    return { data: unitView(unit) };
  }

  @Post('deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate the Cloud-TSE permanently (admins, confirm required)',
    description:
      'Nimmt die TSE endgültig außer Betrieb (Swissbit `disableSecureElement`). Braucht `confirm: true` (sonst 400 TSE_DEACTIVATION_CONFIRM_REQUIRED). Der abschließende Export wird automatisch abgeholt; die Integration wird ausgeschaltet. Danach ist Bargeld in Deutschland gesperrt.',
  })
  async deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeactivateTseDto,
    @CurrentUser() user: User,
    @Req() request: Request,
  ) {
    const unit = await this.units.deactivateByUser(
      id,
      user,
      dto,
      meta(request),
    );
    // Den automatischen Abschlussexport gleich abholen (sonst im naechsten Lauf).
    void this.exports.collectById(unit.id, 'deactivation');
    return { data: unitView(unit) };
  }

  @Get('exports')
  @ApiOperation({
    summary: 'List TSE exports (admins)',
    description:
      'TAR-Exporte (TR-03153) im Archiv von OpenEOS: Zeitraum, Größe, SHA-256, Status (`pending`, `downloaded`, `failed`), Auslöser.',
  })
  async listExports(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return { data: await this.exports.list(id, user) };
  }

  @Post('exports')
  // Dient dem Export: auch in einer geloeschten Organisation (AGB 10.4).
  @ClosedOrganizationAccess()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Export now (admins)',
    description:
      'Startet einen Export der aktiven TSE im Hintergrund und holt ihn ab. Die Liste zeigt den Fortschritt.',
  })
  async requestExport(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Req() request: Request,
  ) {
    const organization = await this.units.assertAdmin(id, user);
    assertIntegrationEnabled(organization.settings, 'tse');
    return { data: await this.exports.requestManual(id, user, meta(request)) };
  }

  @Get('exports/bundle')
  @ApiOperation({
    summary: 'All TSE exports (TAR) of a period as one ZIP (admins)',
    description:
      'Für die Kassen-Nachschau: alle abgeholten TAR-Exporte, die den Zeitraum (Geschäftstage `from`–`to`, 6–6 Uhr) berühren, unverändert in einem ZIP. Header `X-Checksum-SHA256`. 404 TSE_EXPORT_NOT_FOUND, wenn es noch keinen gibt (dann `POST …/tse/exports`).',
  })
  async bundleExports(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: TseExportBundleQueryDto,
    @CurrentUser() user: User,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const from = businessDayRange(query.from).from;
    const to = businessDayRange(query.to ?? query.from).to;
    const file = await this.exports.bundle(id, user, { from, to });
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'X-Checksum-SHA256': file.sha256,
      'Cache-Control': 'no-store',
    });
    return new StreamableFile(file.data, { length: file.data.length });
  }

  @Get('exports/:exportId/download')
  @ApiOperation({
    summary: 'Download a TSE export (admins)',
    description:
      'Liefert das TAR. Header `X-Checksum-SHA256` mit der Prüfsumme.',
  })
  async downloadExport(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('exportId', ParseUUIDPipe) exportId: string,
    @CurrentUser() user: User,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.exports.fileFor(id, exportId, user);
    res.set({
      'Content-Type': 'application/x-tar',
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'X-Checksum-SHA256': file.sha256,
      'Cache-Control': 'no-store',
    });
    return new StreamableFile(this.exports.stream(file.path), {
      length: file.sizeBytes,
    });
  }

  @Get('transactions')
  @ApiOperation({
    summary: 'Signed and failed TSE transactions (admins)',
    description: 'Abgesicherte Vorgänge (neueste zuerst), Filter `status`.',
  })
  async transactions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QueryTseTransactionsDto,
    @CurrentUser() user: User,
  ) {
    return { data: await this.status.transactions(id, user, query) };
  }

  @Get('outages')
  @ApiOperation({
    summary: 'TSE outage log (admins)',
    description:
      'Ausfallprotokoll (AEAO zu § 146a Nr. 1.14): Beginn, Ende, Grund, Anzahl.',
  })
  async outages(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return { data: await this.status.outageList(id, user) };
  }

  @Get('orders/:orderId')
  @ApiOperation({
    summary: 'TSE data of an order (admins)',
    description:
      'Alle TSE-Vorgänge einer Bestellung (Bestellung, Kassenbelege, Gegenbelege) mit QR-Code-Inhalt — für Nachdruck und digitalen Beleg.',
  })
  async forOrder(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentUser() user: User,
  ) {
    await this.units.assertAdmin(id, user);
    const views = await this.signing.forOrder(orderId, id);
    return { data: views };
  }
}
