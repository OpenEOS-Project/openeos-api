import { IsEnum, IsOptional, IsString } from 'class-validator';

export enum OnlinePaymentMethod {
  PAYPAL = 'paypal',
  SUMUP_ONLINE = 'sumup_online',
  GOOGLE_PAY = 'google_pay',
  APPLE_PAY = 'apple_pay',
}

export class CreateOnlinePaymentDto {
  @IsEnum(OnlinePaymentMethod)
  paymentMethod: OnlinePaymentMethod;

  @IsOptional()
  @IsString()
  orderId?: string;

  @IsOptional()
  @IsString()
  returnUrl?: string;
}
