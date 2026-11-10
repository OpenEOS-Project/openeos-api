import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CurrentDevice, Public } from '../../common/decorators';
import { DeviceAuthGuard } from '../../common/guards/device-auth.guard';
import type { AppRequest } from '../../common/types/request.types';
import { Device } from '../../database/entities/device.entity';
import { requireOrganization } from '../devices/device-api.controller';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  DeviceSettleWaiterDto,
  PrintWaiterSummaryDto,
  TransferOrderDto,
  WaiterSessionEndDto,
  WaiterSessionLoginDto,
} from './dto/waiter.dto';
import {
  CurrentOperator,
  WAITER_SESSION_HEADER,
  WithOperator,
} from './waiter-session.guard';
import { type Operator, waiterModeOf, waiterSettings } from './waiter-operator';
import {
  sessionRequiredError,
  WaiterSessionsService,
} from './waiter-sessions.service';
import {
  WaiterSettlementsService,
  type SettlementSubject,
} from './waiter-settlements.service';
import { WaiterTransferService } from './waiter-transfer.service';
import { Organization } from '../../database/entities/organization.entity';

/** Schichtleitung oder Admin-Mitglied (darf andere abrechnen, erzwingen). */
export function isLeadOperator(operator: Operator): boolean {
  return operator.role === 'lead' || operator.role === 'admin';
}

function notPermitted(permission: string, message: string) {
  return new ForbiddenException({
    code: ErrorCodes.FORBIDDEN,
    reason: ErrorReasons.WAITER_NOT_PERMITTED,
    message,
    params: { permission },
  });
}

/** Eigene Zahlen oder (Schichtleitung) die einer anderen Bedienung. */
function subjectFor(
  operator: Operator,
  waiterId: string | undefined,
): SettlementSubject {
  const own: SettlementSubject = operator.waiterId
    ? { kind: 'waiter', waiterId: operator.waiterId }
    : { kind: 'member', userId: operator.userId! };
  if (!waiterId || waiterId === operator.waiterId) return own;
  if (!isLeadOperator(operator)) {
    throw notPermitted(
      'settle',
      'Die Zahlen anderer Bedienungen sieht nur eine Schichtleitung oder ein Admin.',
    );
  }
  return { kind: 'waiter', waiterId };
}

function tokenOf(req: AppRequest): string | undefined {
  const header = req.headers[WAITER_SESSION_HEADER];
  return (Array.isArray(header) ? header[0] : header) || undefined;
}

/** Bedienungs-Sitzung an der Kasse (bedienungen-plan.md §5). */
@ApiTags('Device API')
@ApiHeader({
  name: 'X-Device-Token',
  description: 'Device authentication token',
  required: true,
})
@Controller('device-api')
@Public()
@UseGuards(DeviceAuthGuard)
export class DeviceWaitersController {
  constructor(
    private readonly sessions: WaiterSessionsService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settlements: WaiterSettlementsService,
    private readonly transfers: WaiterTransferService,
  ) {}

  @Post('waiter-session')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Bedienung per PIN anmelden („Wer bedient?“)',
    description:
      'Die PIN allein identifiziert die Bedienung bzw. das Mitglied. Antwort: `token` (Header `X-Waiter-Session` bei jeder Buchung, nur im Speicher halten), `expiresAt`, `kind` (`waiter`|`member`), `waiter` (id, name, shortName, color, role, permissions). Eine vorige Sitzung an diesem Gerät endet (Wechsel). Fehler: 403 PIN_INVALID (`params.remainingAttempts`), 429 PIN_LOCKED (`params.retryAfterSeconds`), 429 PIN_DEVICE_LOCKED (Freigabe durch Admin), 403 WAITER_NOT_FOR_EVENT.',
  })
  async login(
    @CurrentDevice() device: Device,
    @Body() dto: WaiterSessionLoginDto,
  ) {
    requireOrganization(device);
    return { data: await this.sessions.login(device, dto.pin) };
  }

  @Get('waiter-session')
  @ApiOperation({
    summary: 'Aktuelle Bedienungs-Sitzung',
    description:
      '`data: null` ohne gültige Sitzung (dann PIN-Bildschirm). Bei fester Bedienung (`personal`) die Bedienung des Geräts. `mode`: Gerätemodus.',
  })
  async current(@CurrentDevice() device: Device, @Req() req: AppRequest) {
    requireOrganization(device);
    return {
      data: await this.sessions.current(device, tokenOf(req)),
      meta: { mode: waiterModeOf(device.settings) },
    };
  }

  @Delete('waiter-session')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sperren bzw. abmelden',
    description:
      'Beendet die Sitzung des Tokens (`reason`: lock, switch, timeout, logout). Ohne gültiges Token passiert nichts.',
  })
  async end(
    @CurrentDevice() device: Device,
    @Req() req: AppRequest,
    @Body() dto: WaiterSessionEndDto,
  ) {
    requireOrganization(device);
    const ended = await this.sessions.end(
      device,
      tokenOf(req),
      dto?.reason ?? 'lock',
    );
    return { data: { ended } };
  }

  @Get('waiters')
  @ApiOperation({
    summary: 'Kurzliste der Bedienungen (Kacheln, Tischfarben)',
    description:
      'Aktive Bedienungen der laufenden Veranstaltung plus organisationsweite: nur `id`, `shortName` (sonst Vorname) und `color`.',
  })
  async list(@CurrentDevice() device: Device) {
    const organizationId = requireOrganization(device);
    const rows: {
      id: string;
      name: string;
      short_name: string | null;
      color: string | null;
    }[] = await this.dataSource.query(
      `SELECT w.id, w.name, w.short_name, w.color
         FROM waiters w
         LEFT JOIN events e ON e.id = w.event_id
        WHERE w.organization_id = $1
          AND w.is_active = true
          AND w.anonymized_at IS NULL
          AND (w.event_id IS NULL OR e.status IN ('active', 'test'))
        ORDER BY lower(coalesce(w.short_name, w.name))`,
      [organizationId],
    );
    return {
      data: rows.map((r) => ({
        id: r.id,
        shortName: r.short_name || r.name.trim().split(/\s+/)[0].slice(0, 12),
        color: r.color,
      })),
    };
  }

  // ------------------------------------------------------------ Abrechnung

  @Get('waiter/summary')
  @WithOperator()
  @ApiOperation({
    summary: 'Mein Zwischenstand',
    description:
      'Zahlen der angemeldeten Bedienung (bzw. des Mitglieds) seit ihrer letzten Abrechnung in der laufenden Veranstaltung: kassiert je Zahlart mit Trinkgeld, Storno/Erstattungen, Pfand, aufgenommen, Soll bar (informativ, Schublade je Gerät), offene Tische. `waiterId`: andere Bedienung (nur Schichtleitung/Admin). `meta.canSettle`: darf abrechnen; `meta.canForce`: darf trotz offener Tische abrechnen.',
  })
  async summary(
    @CurrentDevice() device: Device,
    @CurrentOperator() operator: Operator | null,
    @Query('waiterId', new ParseUUIDPipe({ optional: true })) waiterId?: string,
  ) {
    const organizationId = requireOrganization(device);
    if (!operator) throw sessionRequiredError();
    const subject = subjectFor(operator, waiterId);
    const data = await this.settlements.summary(organizationId, subject);
    return {
      data,
      meta: await this.settleRights(organizationId, operator, subject),
    };
  }

  @Post('waiter/summary/print')
  @HttpCode(HttpStatus.OK)
  @WithOperator()
  @ApiOperation({
    summary: 'Zwischenstand drucken',
    description:
      'Druckt den unverbindlichen Zwischenstand auf dem Bondrucker des Geräts (`printed: false`, wenn keiner eingerichtet ist).',
  })
  async printSummary(
    @CurrentDevice() device: Device,
    @CurrentOperator() operator: Operator | null,
    @Body() dto: PrintWaiterSummaryDto,
  ) {
    const organizationId = requireOrganization(device);
    if (!operator) throw sessionRequiredError();
    const subject = subjectFor(operator, dto?.waiterId);
    const summary = await this.settlements.summary(organizationId, subject);
    const printed = await this.settlements.printSummary(
      organizationId,
      summary,
      { deviceId: device.id },
      device.name,
    );
    return { data: { printed } };
  }

  @Post('waiter/settlements')
  @WithOperator()
  @ApiOperation({
    summary: 'Abrechnen an der Kasse',
    description:
      'Schichtleitung bzw. Admin-Mitglied rechnet eine Bedienung ab (`waiterId`, sonst sich selbst). Sich selbst abrechnen darf eine Bedienung nur mit der Organisations-Einstellung `selfSettlement`; sonst 403 WAITER_NOT_PERMITTED. Offene Tische: 409 WAITER_OPEN_TABLES, außer `force` + `note` (Schichtleitung). Der Bon geht an den Bondrucker des Geräts (`print: false` unterdrückt ihn).',
  })
  async settle(
    @CurrentDevice() device: Device,
    @CurrentOperator() operator: Operator | null,
    @Body() dto: DeviceSettleWaiterDto,
  ) {
    const organizationId = requireOrganization(device);
    if (!operator) throw sessionRequiredError();
    const subject = subjectFor(operator, dto.waiterId);
    const rights = await this.settleRights(organizationId, operator, subject);
    if (!rights.canSettle) {
      throw notPermitted(
        'settle',
        'Abrechnen darf eine Schichtleitung oder ein Admin.',
      );
    }
    const result = await this.settlements.settle(
      organizationId,
      subject,
      {
        userId: operator.waiterId ? null : operator.userId,
        waiterId: operator.waiterId,
        mayForce: rights.canForce,
        deviceId: device.id,
      },
      {
        countedCash: dto.countedCash ?? null,
        force: dto.force === true,
        note: dto.note ?? null,
        print: dto.print !== false,
      },
    );
    return { data: result.settlement, meta: { printed: result.printed } };
  }

  @Post('orders/:orderId/transfer')
  @HttpCode(HttpStatus.OK)
  @WithOperator()
  @ApiOperation({
    summary: 'Tisch bzw. Bestellung übergeben',
    description:
      'Neue verantwortliche Bedienung für eine offene Bestellung; mit `wholeTable` (Standard) alle offenen Bestellungen desselben Tisches dieser Bedienung. Eigene Tische übergibt jede Bedienung, fremde nur Schichtleitung/Admin (403 WAITER_NOT_PERMITTED). Eintrag im Bestellverlauf, Echtzeit `orderTransferred`.',
  })
  async transfer(
    @CurrentDevice() device: Device,
    @CurrentOperator() operator: Operator | null,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: TransferOrderDto,
  ) {
    const organizationId = requireOrganization(device);
    if (!operator) throw sessionRequiredError();
    return {
      data: await this.transfers.transferOrder(
        organizationId,
        orderId,
        dto.toWaiterId,
        { operator, deviceId: device.id },
        { wholeTable: dto.wholeTable !== false },
      ),
    };
  }

  /** Abrechnen: Schichtleitung/Admin, sich selbst nur mit `selfSettlement`. */
  private async settleRights(
    organizationId: string,
    operator: Operator,
    subject: SettlementSubject,
  ): Promise<{ canSettle: boolean; canForce: boolean }> {
    const lead = isLeadOperator(operator);
    if (lead) return { canSettle: true, canForce: true };
    const self =
      (subject.kind === 'waiter' && subject.waiterId === operator.waiterId) ||
      (subject.kind === 'member' && subject.userId === operator.userId);
    if (!self) return { canSettle: false, canForce: false };
    const organization = await this.dataSource
      .getRepository(Organization)
      .findOne({
        where: { id: organizationId },
        select: { id: true, settings: true },
      });
    return {
      canSettle: waiterSettings(organization).selfSettlement,
      canForce: false,
    };
  }
}
