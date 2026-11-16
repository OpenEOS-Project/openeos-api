import { IsEnum, IsOptional, IsString } from 'class-validator';

/**
 * Online-Zahlung bei der Bestellung per QR-Code: nur noch SumUp Online
 * (Karte, Google Pay, Apple Pay). PayPal ist seit 1.8 entfernt.
 */
export enum OnlinePaymentMethod {
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
