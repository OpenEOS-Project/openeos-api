import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import { CreatePaymentDto, SplitPaymentDto, QueryPaymentsDto } from './dto';

@ApiTags('Payments')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() createDto: CreatePaymentDto,
    @CurrentUser() user: User,
  ) {
    return this.paymentsService.create(organizationId, createDto, user);
  }

  @Post('split')
  createSplitPayment(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() splitDto: SplitPaymentDto,
    @CurrentUser() user: User,
  ) {
    return this.paymentsService.createSplitPayment(organizationId, splitDto, user);
  }

  @Get()
  findAll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: QueryPaymentsDto,
    @CurrentUser() user: User,
  ) {
    return this.paymentsService.findAll(organizationId, user, query);
  }

  @Get(':paymentId')
  findOne(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @CurrentUser() user: User,
  ) {
    return this.paymentsService.findOne(organizationId, paymentId, user);
  }

  @Get('order/:orderId')
  getPaymentsByOrder(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentUser() user: User,
  ) {
    return this.paymentsService.getPaymentsByOrder(organizationId, orderId, user);
  }

  @Post(':paymentId/refund')
  @HttpCode(HttpStatus.OK)
  refund(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @CurrentUser() user: User,
  ) {
    return this.paymentsService.refund(organizationId, paymentId, user);
  }
}
