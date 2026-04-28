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
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiSecurity } from '@nestjs/swagger';
import { OnlineOrdersService } from './online-orders.service';
import { StartSessionDto, AddCartItemDto, UpdateCartItemDto, SubmitOrderDto, CreateOnlinePaymentDto } from './dto';
import { Public } from '../../common/decorators/public.decorator';
import { ErrorCodes } from '../../common/constants/error-codes';

@ApiTags('Online Orders')
@ApiSecurity('X-Session-Token')
@Controller('public/order')
@Public()
export class OnlineOrdersController {
  constructor(private readonly onlineOrdersService: OnlineOrdersService) {}

  private getSessionToken(headers: Record<string, string>): string {
    const token = headers['x-session-token'];
    if (!token) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
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
        eventName: (result.session as unknown as { event?: { name?: string } }).event?.name || null,
        organizationName: (result.session as unknown as { organization?: { name?: string } }).organization?.name || null,
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
        organization: session.organization ? {
          id: session.organization.id,
          name: session.organization.name,
        } : null,
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
    const session = await this.onlineOrdersService.addToCart(sessionToken, addDto);
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
    const session = await this.onlineOrdersService.updateCartItem(sessionToken, index, updateDto);
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
    const order = await this.onlineOrdersService.submitOrder(sessionToken, submitDto);
    return {
      data: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        dailyNumber: order.dailyNumber,
        status: order.status,
        total: order.total,
        items: order.items?.map(item => ({
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

  @Post('pay/confirm')
  async confirmPayment(
    @Headers() headers: Record<string, string>,
    @Body() body: { paymentId: string; providerOrderId: string },
  ) {
    const sessionToken = this.getSessionToken(headers);
    return this.onlineOrdersService.confirmPayment(sessionToken, body.paymentId, body.providerOrderId);
  }

  @Get('status')
  async getOrderStatus(@Headers() headers: Record<string, string>) {
    const sessionToken = this.getSessionToken(headers);
    const orders = await this.onlineOrdersService.getOrderStatus(sessionToken);
    return {
      data: orders.map(order => ({
        id: order.id,
        orderNumber: order.orderNumber,
        dailyNumber: order.dailyNumber,
        status: order.status,
        paymentStatus: order.paymentStatus,
        total: order.total,
        createdAt: order.createdAt,
        items: order.items?.map(item => ({
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
