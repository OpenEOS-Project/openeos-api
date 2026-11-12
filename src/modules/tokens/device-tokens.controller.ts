import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentDevice } from '../../common/decorators';
import { Public } from '../../common/decorators/public.decorator';
import { DeviceAuthGuard } from '../../common/guards/device-auth.guard';
import { DeviceCapabilityGuard } from '../../common/guards/device-capability.guard';
import { DeviceCapability } from '../../common/decorators/device-capability.decorator';
import { DeviceCapabilityName } from '../../common/constants/device-capabilities';
import type { Device } from '../../database/entities/device.entity';
import { requireOrganization } from '../devices/device-api.controller';
import { CurrentOperator, WithOperator } from '../waiters/waiter-session.guard';
import type { Operator } from '../waiters/waiter-operator';
import { assertOperatorMay } from '../waiters/waiter-sessions.service';
import {
  CreateTokenBuybackDto,
  CreateTokenSaleDto,
  PrintTokenTransactionDto,
} from './dto';
import { TokenTransactionsService } from './token-transactions.service';
import { TokenTypesService } from './token-types.service';

@ApiTags('Device API')
@ApiHeader({
  name: 'X-Device-Token',
  description: 'Device authentication token',
  required: true,
})
@Controller('device-api')
@Public()
@UseGuards(DeviceAuthGuard, DeviceCapabilityGuard)
export class DeviceTokensController {
  constructor(
    private readonly tokenTypesService: TokenTypesService,
    private readonly tokenTransactionsService: TokenTransactionsService,
  ) {}

  @DeviceCapability(DeviceCapabilityName.CATALOG)
  @Get('token-types')
  @ApiOperation({
    summary: 'Markentypen (Wertmarken) für die Kasse',
    description:
      'Aktive Markentypen der Veranstaltung und organisationsweite. Leer, wo Wertmarken nicht erlaubt sind („Bargeldlos“, „Nur Bons“, Deutschland ohne aktive Cloud-TSE).',
  })
  @ApiQuery({ name: 'eventId', required: false })
  async list(
    @CurrentDevice() device: Device,
    @Query('eventId', new ParseUUIDPipe({ optional: true })) eventId?: string,
  ) {
    const organizationId = requireOrganization(device);
    return {
      data: await this.tokenTypesService.findForDevice(
        organizationId,
        eventId ?? null,
      ),
    };
  }

  @DeviceCapability(DeviceCapabilityName.SALES)
  @Post('tokens/sales')
  @WithOperator()
  @ApiOperation({
    summary: 'Wertmarken verkaufen',
    description:
      'Bar, Karte oder SumUp. Kein Umsatz: Mehrzweckgutschein nicht steuerbar (TSE `MehrzweckgutscheinKauf`), Einzweckgutschein mit seinem Satz. Bar zählt ins Kassenbuch. 403 wie Bargeld außerhalb von „Alle Funktionen“ bzw. TSE_REQUIRED_FOR_TOKENS in Deutschland ohne aktive Cloud-TSE.',
  })
  async sell(
    @CurrentDevice() device: Device,
    @Body() dto: CreateTokenSaleDto,
    @CurrentOperator() operator: Operator | null = null,
  ) {
    const organizationId = requireOrganization(device);
    return {
      data: await this.tokenTransactionsService.sell(organizationId, dto, {
        deviceId: device.id,
        deviceName: device.name,
        cashDrawerPrinterId:
          (device.settings?.cashDrawerPrinterId as string | undefined) ?? null,
        userId: operator?.userId ?? null,
        waiterId: operator?.waiterId ?? null,
        actorName: operator?.name ?? null,
      }),
    };
  }

  @DeviceCapability(DeviceCapabilityName.SALES)
  @Post('tokens/buybacks')
  @WithOperator()
  @ApiOperation({
    summary: 'Wertmarken zurücktauschen (Bargeld auszahlen)',
    description:
      'Nur Typen mit „Rücktausch erlaubt“ (400 TOKEN_BUYBACK_NOT_ALLOWED), höchstens der Bestand im Umlauf (409 TOKEN_BUYBACK_EXCEEDS_OUTSTANDING), Bedienungen brauchen das Recht „Storno/Erstattung“. Beleg mit Unterschriftszeile wird immer gedruckt.',
  })
  async buyback(
    @CurrentDevice() device: Device,
    @Body() dto: CreateTokenBuybackDto,
    @CurrentOperator() operator: Operator | null = null,
  ) {
    const organizationId = requireOrganization(device);
    assertOperatorMay(operator, 'refund');
    return {
      data: await this.tokenTransactionsService.buyback(organizationId, dto, {
        deviceId: device.id,
        deviceName: device.name,
        cashDrawerPrinterId:
          (device.settings?.cashDrawerPrinterId as string | undefined) ?? null,
        userId: operator?.userId ?? null,
        waiterId: operator?.waiterId ?? null,
        actorName: operator?.name ?? null,
      }),
    };
  }

  @DeviceCapability(DeviceCapabilityName.SALES)
  @Post('tokens/transactions/:tokenTransactionId/print')
  @ApiOperation({
    summary: 'Beleg eines Markenverkaufs/Rücktauschs drucken',
    description: '`reprint: true` druckt den Vermerk „NACHDRUCK“.',
  })
  async print(
    @CurrentDevice() device: Device,
    @Param('tokenTransactionId', ParseUUIDPipe) id: string,
    @Body() body: PrintTokenTransactionDto,
  ) {
    const organizationId = requireOrganization(device);
    const result = await this.tokenTransactionsService.printReceipt(
      organizationId,
      id,
      {
        deviceId: device.id,
        deviceName: device.name,
        reprint: body?.reprint === true,
      },
    );
    return { data: { success: true, printed: result.printed } };
  }
}
