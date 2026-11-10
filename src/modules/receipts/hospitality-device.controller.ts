import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import type { Device } from '../../database/entities';
import { requireOrganization } from '../devices/device-api.controller';
import { CurrentOperator, WithOperator } from '../waiters/waiter-session.guard';
import { attributionOf, type Operator } from '../waiters/waiter-operator';
import {
  HospitalityEmailDto,
  IssueHospitalityReceiptDto,
} from './dto/receipt.dto';
import { HospitalityReceiptsService } from './hospitality-receipts.service';
import type { ReceiptActor } from './receipts.service';

/**
 * Bewirtungsbeleg an der Kasse (nach der Zahlung bzw. aus dem Verlauf):
 * prüfen, ausstellen, drucken, als QR-Code oder per E-Mail ausgeben.
 */
@ApiTags('Device API')
@ApiHeader({
  name: 'X-Device-Token',
  description: 'Device authentication token',
  required: true,
})
@Controller('device-api/hospitality-receipts')
@Public()
@UseGuards(DeviceAuthGuard)
export class HospitalityDeviceController {
  constructor(private readonly hospitality: HospitalityReceiptsService) {}

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

  @Get('check')
  @ApiOperation({
    summary: 'Bewirtungsbeleg vorbereiten',
    description:
      'Vorhandener Beleg zu den Bestellungen, Betrag, ob der Name des Bewirtenden Pflicht ist (über 250 €), fehlende Stammdaten des Vereins, Sammelbezeichnungen unter den Artikeln und der erlaubte Tag der Bewirtung.',
  })
  @ApiQuery({ name: 'orderIds', description: 'Kommagetrennte Bestell-IDs' })
  async check(
    @CurrentDevice() device: Device,
    @Query('orderIds') orderIds: string,
  ) {
    const ids = String(orderIds ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    return {
      data: await this.hospitality.check(requireOrganization(device), ids),
    };
  }

  @Post()
  @HttpCode(200)
  @WithOperator()
  @ApiOperation({
    summary: 'Bewirtungsbeleg ausstellen',
    description:
      'Vergibt die nächste Nummer (B-JJJJ-NNNN, lückenlos je Organisation und Jahr) und speichert den Beleg unveränderlich. 409 `HOSPITALITY_MASTER_DATA_REQUIRED` (`params.missing`), 409 `HOSPITALITY_ITEMS_NOT_SPECIFIC`, 400 `HOSPITALITY_RECIPIENT_REQUIRED` über 250 €, 409 `HOSPITALITY_RECEIPT_EXISTS`. Gibt es für genau diese Bestellungen schon einen Beleg, kommt er zurück (`existing: true`).',
  })
  async issue(
    @CurrentDevice() device: Device,
    @Body() body: IssueHospitalityReceiptDto,
    @CurrentOperator() operator: Operator | null = null,
  ) {
    return {
      data: await this.hospitality.issue(this.actor(device, operator), body),
    };
  }

  @Post(':id/print')
  @HttpCode(200)
  @WithOperator()
  @ApiOperation({
    summary: 'Bewirtungsbeleg drucken',
    description:
      'Bon-Drucker dieser Kasse (sonst der Organisation). Ab der zweiten Ausgabe mit „KOPIE“. `printed: false`, wenn kein Drucker gefunden wurde.',
  })
  async print(
    @CurrentDevice() device: Device,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentOperator() operator: Operator | null = null,
  ) {
    return {
      data: await this.hospitality.print(this.actor(device, operator), id),
    };
  }

  @Post(':id/link')
  @HttpCode(200)
  @WithOperator()
  @ApiOperation({ summary: 'Bewirtungsbeleg als Link (QR-Code)' })
  async link(
    @CurrentDevice() device: Device,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentOperator() operator: Operator | null = null,
  ) {
    return {
      data: await this.hospitality.link(this.actor(device, operator), id),
    };
  }

  @Post(':id/email')
  @HttpCode(200)
  @WithOperator()
  @ApiOperation({
    summary: 'Bewirtungsbeleg per E-Mail',
    description:
      'HTML + PDF. Die Adresse wird nicht gespeichert; gleiche Grenzen wie beim Kassenbeleg.',
  })
  async email(
    @CurrentDevice() device: Device,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: HospitalityEmailDto,
    @CurrentOperator() operator: Operator | null = null,
  ) {
    return {
      data: await this.hospitality.email(
        this.actor(device, operator),
        id,
        body.email,
      ),
    };
  }
}
