import { isOrdersOnly } from '../../common/utils/operating-mode.util';
import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Headers,
  ParseIntPipe,
  ParseUUIDPipe,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiSecurity, ApiOperation } from '@nestjs/swagger';
import { OnlineOrdersService } from './online-orders.service';
import {
  StartSessionDto,
  AddCartItemDto,
  UpdateCartItemDto,
  SubmitOrderDto,
  CreateOnlinePaymentDto,
} from './dto';
import { Public } from '../../common/decorators/public.decorator';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { DeploymentService } from '../../common/services/deployment.service';
import { toPublicLegalInfo } from '../organizations/legal/legal-settings.util';

@ApiTags('Online Orders')
@ApiSecurity('X-Session-Token')
@Controller('public/order')
@Public()
export class OnlineOrdersController {
  constructor(
    private readonly onlineOrdersService: OnlineOrdersService,
    private readonly deployment: DeploymentService,
  ) {}

  private getSessionToken(headers: Record<string, string>): string {
    const token = headers['x-session-token'];
    if (!token) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.SESSION_TOKEN_REQUIRED,
        message: 'Session-Token erforderlich',
      });
    }
    return token;
  }

  @Get('events/:organizationId')
  async getPublicEvents(@Param('organizationId') organizationId: string) {
    return this.onlineOrdersService.getPublicEvents(organizationId);
  }

  @Post('session')
  async startSession(@Body() startDto: StartSessionDto) {
    const result = await this.onlineOrdersService.startSession(startDto);
    return {
      data: {
        sessionToken: result.sessionToken,
        eventName:
          (result.session as unknown as { event?: { name?: string } }).event
            ?.name || null,
        organizationName:
          (result.session as unknown as { organization?: { name?: string } })
            .organization?.name || null,
        session: {
          id: result.session.id,
          tableNumber: result.session.tableNumber,
          status: result.session.status,
          expiresAt: result.session.expiresAt,
        },
      },
    };
  }

  @Get('session')
  async getSession(@Headers() headers: Record<string, string>) {
    const sessionToken = this.getSessionToken(headers);
    const session = await this.onlineOrdersService.getSession(sessionToken);
    return {
      data: {
        id: session.id,
        tableNumber: session.tableNumber,
        status: session.status,
        cart: session.cart,
        expiresAt: session.expiresAt,
        organization: session.organization
          ? {
              id: session.organization.id,
              name: session.organization.name,
            }
          : null,
        // Betriebsart „Nur Bons“: keine Bestellung per QR-Code.
        onlineOrderingAvailable: !isOrdersOnly(session.organization),
        /* Impressum und Datenschutzhinweis des Vereins (wie im Shop), dazu
           die Plattform-Links von OpenEOS. Fehlt eins davon
           (`complete: false`), lehnt POST submit mit 403
           LEGAL_INFO_MISSING ab. */
        legal: toPublicLegalInfo(
          session.organization,
          this.deployment.platformLegal,
        ),
      },
    };
  }

  @Get('menu')
  async getMenu(@Headers() headers: Record<string, string>) {
    const sessionToken = this.getSessionToken(headers);
    const menu = await this.onlineOrdersService.getMenu(sessionToken);
    return {
      data: menu,
    };
  }

  @Post('cart')
  async addToCart(
    @Headers() headers: Record<string, string>,
    @Body() addDto: AddCartItemDto,
  ) {
    const sessionToken = this.getSessionToken(headers);
    const session = await this.onlineOrdersService.addToCart(
      sessionToken,
      addDto,
    );
    return {
      data: {
        cart: session.cart,
      },
    };
  }

  @Patch('cart/:index')
  async updateCartItem(
    @Headers() headers: Record<string, string>,
    @Param('index', ParseIntPipe) index: number,
    @Body() updateDto: UpdateCartItemDto,
  ) {
    const sessionToken = this.getSessionToken(headers);
    const session = await this.onlineOrdersService.updateCartItem(
      sessionToken,
      index,
      updateDto,
    );
    return {
      data: {
        cart: session.cart,
      },
    };
  }

  @Delete('cart')
  async clearCart(@Headers() headers: Record<string, string>) {
    const sessionToken = this.getSessionToken(headers);
    const session = await this.onlineOrdersService.clearCart(sessionToken);
    return {
      data: {
        cart: session.cart,
      },
    };
  }

  @Post('submit')
  async submitOrder(
    @Headers() headers: Record<string, string>,
    @Body() submitDto: SubmitOrderDto,
  ) {
    const sessionToken = this.getSessionToken(headers);
    const order = await this.onlineOrdersService.submitOrder(
      sessionToken,
      submitDto,
    );
    return {
      data: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        dailyNumber: order.dailyNumber,
        status: order.status,
        total: order.total,
        items:
          order.items?.map((item) => ({
            id: item.id,
            productName: item.productName,
            quantity: item.quantity,
            totalPrice: item.totalPrice,
            status: item.status,
          })) || [],
      },
    };
  }

  @Post('pay')
  async initiatePayment(
    @Headers() headers: Record<string, string>,
    @Body() payDto: CreateOnlinePaymentDto,
  ) {
    const sessionToken = this.getSessionToken(headers);
    return this.onlineOrdersService.initiatePayment(sessionToken, payDto);
  }

  /**
   * Rueckkehr nach dem Bezahlen. PayPal: erfasst die Zahlung. SumUp (Karte,
   * Google Pay, Apple Pay): sieht bei SumUp nach und bucht bei „bezahlt“.
   * `providerOrderId` ist nur noch zur Kontrolle (PayPal); gebucht wird
   * immer die Anbieter-Referenz, die zur Zahlung gespeichert ist.
   * Antwort `status`: captured | already_captured | pending | failed.
   */
  @Post('pay/confirm')
  async confirmPayment(
    @Headers() headers: Record<string, string>,
    @Body() body: { paymentId: string; providerOrderId?: string },
  ) {
    const sessionToken = this.getSessionToken(headers);
    return this.onlineOrdersService.confirmPayment(
      sessionToken,
      body.paymentId,
      body.providerOrderId,
    );
  }

  /**
   * SumUp meldet den Stand des Online-Checkouts dieser Zahlung (`return_url`
   * des Checkouts). Der Inhalt wird nicht geglaubt: gebucht wird nur, was
   * SumUp auf Nachfrage als bezahlt bestaetigt. Antwortet immer 200.
   */
  @Post('pay/:paymentId/webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'SumUp payment-status webhook for QR order payments; re-verified against SumUp',
  })
  async sumUpWebhook(@Param('paymentId', ParseUUIDPipe) paymentId: string) {
    await this.onlineOrdersService.handleSumUpWebhook(paymentId);
    return { received: true };
  }

  @Get('status')
  async getOrderStatus(@Headers() headers: Record<string, string>) {
    const sessionToken = this.getSessionToken(headers);
    const orders = await this.onlineOrdersService.getOrderStatus(sessionToken);
    return {
      data: orders.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        dailyNumber: order.dailyNumber,
        status: order.status,
        paymentStatus: order.paymentStatus,
        total: order.total,
        createdAt: order.createdAt,
        items:
          order.items?.map((item) => ({
            id: item.id,
            productName: item.productName,
            quantity: item.quantity,
            totalPrice: item.totalPrice,
            status: item.status,
          })) || [],
      })),
    };
  }
}
