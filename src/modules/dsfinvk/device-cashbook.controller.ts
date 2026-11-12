import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentDevice, Public } from '../../common/decorators';
import { DeviceAuthGuard } from '../../common/guards/device-auth.guard';
import { DeviceCapabilityGuard } from '../../common/guards/device-capability.guard';
import { DeviceCapability } from '../../common/decorators/device-capability.decorator';
import { DeviceCapabilityName } from '../../common/constants/device-capabilities';
import type { Device } from '../../database/entities';
import { requireOrganization } from '../devices/device-api.controller';
import { CashbookService } from './cashbook.service';
import { CreateCashbookEntryDto } from './dto/dsfinvk.dto';
import { CurrentOperator, WithOperator } from '../waiters/waiter-session.guard';
import type { Operator } from '../waiters/waiter-operator';
import { assertOperatorMay } from '../waiters/waiter-sessions.service';

/** Kassenbuch an der Kasse (Menüpunkt „Kassenbuch“). */
@ApiTags('Device API')
@ApiHeader({
  name: 'X-Device-Token',
  description: 'Device authentication token',
  required: true,
})
@Controller('device-api/cashbook')
@Public()
@UseGuards(DeviceAuthGuard, DeviceCapabilityGuard)
export class DeviceCashbookController {
  constructor(private readonly cashbook: CashbookService) {}

  @DeviceCapability(DeviceCapabilityName.SALES)
  @Get()
  @ApiOperation({
    summary: 'Cash book of today for this device',
    description:
      'Heutiger Geschäftstag (6–6 Uhr): Buchungen dieses Geräts und Soll-Bestand seiner Schublade; `cashAllowed` = Bargeld erlaubt (sonst kein Kassenbuch).',
  })
  async today(@CurrentDevice() device: Device) {
    const organizationId = requireOrganization(device);
    return {
      data: await this.cashbook.day(organizationId, undefined, device.id),
    };
  }

  @DeviceCapability(DeviceCapabilityName.SALES)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Book a cash book entry at the till',
    description:
      'Anfangsbestand (Wechselgeld), Einlage, Entnahme/Abschöpfung (Geldtransit) oder Kassensturz (gezählter Bestand → Differenz Soll/Ist). Jede Bargeldbewegung ist ein eigener TSE-gesicherter Beleg (Kassenbeleg-V1, `tse` in der Antwort). Nur wenn Bargeld erlaubt ist.',
  })
  @WithOperator()
  async create(
    @CurrentDevice() device: Device,
    @Body() dto: CreateCashbookEntryDto,
    @CurrentOperator() operator: Operator | null = null,
  ) {
    const organizationId = requireOrganization(device);
    // Bedienung: nur mit Recht `cashbook` (Schichtleitung).
    assertOperatorMay(operator, 'cashbook');
    return {
      data: await this.cashbook.create(organizationId, dto, {
        deviceId: device.id,
        userId: operator?.userId ?? null,
        waiterId: operator?.waiterId ?? null,
      }),
    };
  }
}
