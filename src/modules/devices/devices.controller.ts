import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { DevicesService } from './devices.service';
import { GatewayService } from '../gateway/gateway.service';
import { CurrentUser, ApiTokenAccess } from '../../common/decorators';
import { TokenScope } from '../api-tokens/api-scopes';
import { User } from '../../database/entities';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CreateDeviceDto, UpdateDeviceDto, VerifyDeviceDto } from './dto';

@ApiTags('Devices')
@ApiParam({
  name: 'organizationId',
  description: 'ID der Organisation',
  format: 'uuid',
})
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/devices')
export class DevicesController {
  constructor(
    private readonly devicesService: DevicesService,
    private readonly gatewayService: GatewayService,
  ) {}

  @Post()
  create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() createDto: CreateDeviceDto,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.create(organizationId, createDto, user);
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get()
  @ApiOperation({
    operationId: 'listDevices',
    summary: 'Geräte auflisten',
    description:
      'Kassen und Displays der Organisation mit Status, seitenweise (`page`, `limit`). Scope `read`; koppeln, sperren und löschen geht nur in der App.',
  })
  findAll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() pagination: PaginationDto,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.findAll(organizationId, user, pagination);
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get(':deviceId')
  @ApiOperation({
    operationId: 'getDevice',
    summary: 'Gerät abrufen',
    description:
      'Ein Gerät der Organisation mit Einstellungen und letztem Kontakt. Scope `read`.',
  })
  @ApiParam({ name: 'deviceId', description: 'ID des Geräts', format: 'uuid' })
  findOne(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.findOne(organizationId, deviceId, user);
  }

  @Patch(':deviceId')
  update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @Body() updateDto: UpdateDeviceDto,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.update(
      organizationId,
      deviceId,
      updateDto,
      user,
    );
  }

  @Delete(':deviceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.remove(organizationId, deviceId, user);
  }

  @Post(':deviceId/regenerate-token')
  @HttpCode(HttpStatus.OK)
  regenerateToken(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.regenerateToken(organizationId, deviceId, user);
  }

  @Post(':deviceId/verify')
  @HttpCode(HttpStatus.OK)
  verify(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @Body() verifyDto: VerifyDeviceDto,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.verifyDevice(
      organizationId,
      deviceId,
      verifyDto.code,
      user,
      verifyDto.type,
    );
  }

  @Post(':deviceId/block')
  @HttpCode(HttpStatus.OK)
  block(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.blockDevice(organizationId, deviceId, user);
  }

  @Post(':deviceId/unblock')
  @HttpCode(HttpStatus.OK)
  unblock(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.unblockDevice(organizationId, deviceId, user);
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get(':deviceId/stats')
  @ApiOperation({
    operationId: 'getDeviceStats',
    summary: 'Gerätestatistik',
    description:
      'Bestellungen, Zahlungen und Umsatz, die über dieses Gerät liefen, dazu Online-Status und letzter Kontakt. Scope `read`.',
  })
  @ApiParam({ name: 'deviceId', description: 'ID des Geräts', format: 'uuid' })
  getDeviceStats(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.getDeviceStats(organizationId, deviceId, user);
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('online/ids')
  @ApiOperation({
    operationId: 'listOnlineDeviceIds',
    summary: 'IDs der verbundenen Geräte',
    description:
      'Liefert die IDs der Geräte, die gerade per WebSocket mit der API verbunden sind. Scope `read`.',
  })
  async getOnlineDeviceIds(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() _user: User,
  ) {
    const onlineIds =
      await this.gatewayService.getOnlineDeviceIds(organizationId);
    return { data: onlineIds };
  }
}
