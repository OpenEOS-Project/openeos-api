import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
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
import { WaiterSessionEndDto, WaiterSessionLoginDto } from './dto/waiter.dto';
import { WAITER_SESSION_HEADER } from './waiter-session.guard';
import { waiterModeOf } from './waiter-operator';
import { WaiterSessionsService } from './waiter-sessions.service';

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
}
