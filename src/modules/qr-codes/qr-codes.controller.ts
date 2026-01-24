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
import { QrCodesService } from './qr-codes.service';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CreateQrCodeDto, UpdateQrCodeDto, BulkCreateQrCodesDto } from './dto';

@ApiTags('QR Codes')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/qr-codes')
export class QrCodesController {
  constructor(private readonly qrCodesService: QrCodesService) {}

  @Post()
  create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() createDto: CreateQrCodeDto,
    @CurrentUser() user: User,
  ) {
    return this.qrCodesService.create(organizationId, createDto, user);
  }

  @Post('bulk')
  bulkCreate(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() bulkDto: BulkCreateQrCodesDto,
    @CurrentUser() user: User,
  ) {
    return this.qrCodesService.bulkCreate(organizationId, bulkDto, user);
  }

  @Get()
  findAll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() pagination: PaginationDto,
    @CurrentUser() user: User,
  ) {
    return this.qrCodesService.findAll(organizationId, user, pagination);
  }

  @Get(':qrCodeId')
  findOne(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('qrCodeId', ParseUUIDPipe) qrCodeId: string,
    @CurrentUser() user: User,
  ) {
    return this.qrCodesService.findOne(organizationId, qrCodeId, user);
  }

  @Patch(':qrCodeId')
  update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('qrCodeId', ParseUUIDPipe) qrCodeId: string,
    @Body() updateDto: UpdateQrCodeDto,
    @CurrentUser() user: User,
  ) {
    return this.qrCodesService.update(organizationId, qrCodeId, updateDto, user);
  }

  @Delete(':qrCodeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('qrCodeId', ParseUUIDPipe) qrCodeId: string,
    @CurrentUser() user: User,
  ) {
    return this.qrCodesService.remove(organizationId, qrCodeId, user);
  }

  @Get(':qrCodeId/image')
  getImage(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('qrCodeId', ParseUUIDPipe) qrCodeId: string,
    @Query('format') format: 'png' | 'svg',
    @CurrentUser() user: User,
  ) {
    return this.qrCodesService.getImage(organizationId, qrCodeId, user, format || 'svg');
  }
}
