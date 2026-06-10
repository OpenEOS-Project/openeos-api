import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DiscountVouchersService } from './discount-vouchers.service';
import { CreateDiscountVoucherDto, UpdateDiscountVoucherDto } from './dto';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';

@ApiTags('Discount Vouchers')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/discount-vouchers')
export class DiscountVouchersController {
  constructor(
    private readonly discountVouchersService: DiscountVouchersService,
  ) {}

  @Post()
  async create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() createDto: CreateDiscountVoucherDto,
    @CurrentUser() user: User,
  ) {
    const voucher = await this.discountVouchersService.create(
      organizationId,
      createDto,
      user,
    );
    return { data: voucher };
  }

  @Get()
  async findAll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    const vouchers = await this.discountVouchersService.findAll(
      organizationId,
      user,
    );
    return { data: vouchers };
  }

  @Get(':voucherId')
  async findOne(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('voucherId', ParseUUIDPipe) voucherId: string,
    @CurrentUser() user: User,
  ) {
    const voucher = await this.discountVouchersService.findOne(
      organizationId,
      voucherId,
      user,
    );
    return { data: voucher };
  }

  @Patch(':voucherId')
  async update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('voucherId', ParseUUIDPipe) voucherId: string,
    @Body() updateDto: UpdateDiscountVoucherDto,
    @CurrentUser() user: User,
  ) {
    const voucher = await this.discountVouchersService.update(
      organizationId,
      voucherId,
      updateDto,
      user,
    );
    return { data: voucher };
  }

  @Delete(':voucherId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('voucherId', ParseUUIDPipe) voucherId: string,
    @CurrentUser() user: User,
  ) {
    await this.discountVouchersService.remove(organizationId, voucherId, user);
  }
}
