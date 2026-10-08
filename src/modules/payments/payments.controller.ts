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
import { BadRequestException } from '@nestjs/common';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { RefundsService } from '../refunds/refunds.service';
import { PaymentsService } from './payments.service';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import { CreatePaymentDto, SplitPaymentDto, QueryPaymentsDto } from './dto';

@ApiTags('Payments')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/payments')
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly refundsService: RefundsService,
  ) {}

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
    return this.paymentsService.createSplitPayment(
      organizationId,
      splitDto,
      user,
    );
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
    return this.paymentsService.getPaymentsByOrder(
      organizationId,
      orderId,
      user,
    );
  }

  /**
   * Erstattet den noch offenen Betrag dieser Zahlung mit Gegenbeleg
   * (wie `POST orders/:orderId/refunds` mit `mode: amount, paymentId`).
   * Frueher setzte dieser Endpunkt nur den Status auf `refunded`.
   */
  @Post(':paymentId/refund')
  @HttpCode(HttpStatus.OK)
  async refund(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @CurrentUser() user: User,
  ) {
    const payment = await this.paymentsService.findOne(
      organizationId,
      paymentId,
      user,
    );
    const actor = await this.refundsService.resolveAdminActor(
      organizationId,
      user,
    );
    const detail = await this.refundsService.detail(
      organizationId,
      payment.orderId,
    );
    const refundable =
      detail.payments.find((p) => p.id === paymentId)?.refundable ?? 0;
    if (refundable <= 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.PAYMENT_ALREADY_REFUNDED,
        message: 'Zahlung wurde bereits erstattet',
      });
    }
    await this.refundsService.createRefund(actor, payment.orderId, {
      mode: 'amount',
      amount: refundable,
      paymentId,
      reasonCode: 'other',
    });
    return this.paymentsService.findOne(organizationId, paymentId, user);
  }
}
