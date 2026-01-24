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
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DevicesService } from './devices.service';
import { GatewayService } from '../gateway/gateway.service';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CreateDeviceDto, UpdateDeviceDto, VerifyDeviceDto } from './dto';

@ApiTags('Devices')
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

  @Get()
  findAll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() pagination: PaginationDto,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.findAll(organizationId, user, pagination);
  }

  @Get(':deviceId')
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
    return this.devicesService.update(organizationId, deviceId, updateDto, user);
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
    return this.devicesService.verifyDevice(organizationId, deviceId, verifyDto.code, user);
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

  @Get('online/ids')
  getOnlineDeviceIds(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() _user: User,
  ) {
    const onlineIds = this.gatewayService.getOnlineDeviceIds(organizationId);
    return { data: onlineIds };
  }
}
