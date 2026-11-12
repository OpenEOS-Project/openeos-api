import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentDevice } from '../../common/decorators';
import { Public } from '../../common/decorators/public.decorator';
import { DeviceAuthGuard } from '../../common/guards/device-auth.guard';
import { DeviceCapabilityGuard } from '../../common/guards/device-capability.guard';
import { DeviceCapability } from '../../common/decorators/device-capability.decorator';
import { DeviceCapabilityName } from '../../common/constants/device-capabilities';
import type { Device } from '../../database/entities';
import { requireOrganization } from '../devices/device-api.controller';
import { CurrentOperator, WithOperator } from '../waiters/waiter-session.guard';
import { attributionOf, type Operator } from '../waiters/waiter-operator';
import { ReceiptOrdersDto, SendReceiptEmailDto } from './dto/receipt.dto';
import { ReceiptsService, type ReceiptActor } from './receipts.service';

/**
 * „Beleg“ an der Kasse nach der Zahlung bzw. aus dem Verlauf: QR-Code
 * (Link auf den digitalen Beleg) und E-Mail. „Bon drucken“ ist
 * `POST /device-api/orders/:orderId/reprint` mit `type: receipt`.
 */
@ApiTags('Device API')
@ApiHeader({
  name: 'X-Device-Token',
  description: 'Device authentication token',
  required: true,
})
@Controller('device-api/receipts')
@Public()
@UseGuards(DeviceAuthGuard, DeviceCapabilityGuard)
export class ReceiptsDeviceController {
  constructor(private readonly receipts: ReceiptsService) {}

  private actor(device: Device, operator: Operator | null): ReceiptActor {
    const who = attributionOf(operator);
    return {
      organizationId: requireOrganization(device),
      deviceId: device.id,
      userId: who.userId,
      waiterId: who.waiterId,
      actorName: who.name ?? device.name,
    };
  }

  @DeviceCapability(DeviceCapabilityName.SALES)
  @Post('link')
  @HttpCode(200)
  @WithOperator()
  @ApiOperation({
    summary: 'Digitalen Beleg als Link (QR-Code) ausgeben',
    description:
      'Erzeugt einen Link auf den Kassenbeleg der Bestellungen (gleicher Inhalt wie der gedruckte Bon, ohne Gästeangaben). Der Link enthält ein zufälliges 128-Bit-Token, gespeichert wird nur dessen SHA-256. Gültig `RECEIPT_LINK_DAYS` Tage (Standard 90). 409 `RECEIPT_NOT_AVAILABLE` in der Betriebsart „Nur Bons“ oder ohne Zahlung.',
  })
  async link(
    @CurrentDevice() device: Device,
    @Body() body: ReceiptOrdersDto,
    @CurrentOperator() operator: Operator | null = null,
  ) {
    return {
      data: await this.receipts.createLink(
        this.actor(device, operator),
        body.orderIds,
      ),
    };
  }

  @DeviceCapability(DeviceCapabilityName.SALES)
  @Post('email')
  @HttpCode(200)
  @WithOperator()
  @ApiOperation({
    summary: 'Digitalen Beleg per E-Mail schicken',
    description:
      'Schickt den Kassenbeleg als HTML mit PDF-Anhang. Absendername ist der Verein, Antworten gehen an seine Kontaktadresse. Die Adresse wird nicht gespeichert und nicht protokolliert; im Verlauf der Bestellung steht nur „Beleg per E-Mail“. Grenzen: `RECEIPT_EMAIL_DEVICE_LIMIT_PER_HOUR` je Gerät (Standard 30) und `RECEIPT_EMAIL_ORDER_LIMIT` je Bestellung (Standard 5), sonst 429 `RECEIPT_EMAIL_RATE_LIMITED`.',
  })
  async email(
    @CurrentDevice() device: Device,
    @Body() body: SendReceiptEmailDto,
    @CurrentOperator() operator: Operator | null = null,
  ) {
    return {
      data: await this.receipts.sendEmail(
        this.actor(device, operator),
        body.orderIds,
        body.email,
      ),
    };
  }
}
