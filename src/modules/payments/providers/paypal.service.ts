import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface PayPalOrderResponse {
  id: string;
  status: string;
  links: { href: string; rel: string; method: string }[];
}

interface PayPalCaptureResponse {
  id: string;
  status: string;
  purchase_units: { payments: { captures: { id: string; amount: { value: string } }[] } }[];
}

@Injectable()
export class PayPalService {
  private readonly logger = new Logger(PayPalService.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    const sandbox = this.configService.get<boolean>('PAYPAL_SANDBOX', true);
    this.baseUrl = sandbox
      ? 'https://api-m.sandbox.paypal.com'
      : 'https://api-m.paypal.com';
  }

  private async getAccessToken(clientId: string, clientSecret: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      throw new Error(`PayPal auth failed: ${response.status}`);
    }

    const data = await response.json() as { access_token: string };
    return data.access_token;
  }

  async createOrder(
    amount: number,
    currency: string,
    description: string,
    returnUrl: string,
    cancelUrl: string,
    clientId: string,
    clientSecret: string,
  ): Promise<PayPalOrderResponse> {
    const accessToken = await this.getAccessToken(clientId, clientSecret);

    const response = await fetch(`${this.baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: currency,
            value: amount.toFixed(2),
          },
          description,
        }],
        application_context: {
          return_url: returnUrl,
          cancel_url: cancelUrl,
          brand_name: 'OpenEOS',
          user_action: 'PAY_NOW',
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`PayPal create order failed: ${error}`);
      throw new Error(`PayPal create order failed: ${response.status}`);
    }

    return response.json() as Promise<PayPalOrderResponse>;
  }

  async captureOrder(
    paypalOrderId: string,
    clientId: string,
    clientSecret: string,
  ): Promise<PayPalCaptureResponse> {
    const accessToken = await this.getAccessToken(clientId, clientSecret);

    const response = await fetch(`${this.baseUrl}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`PayPal capture failed: ${error}`);
      throw new Error(`PayPal capture failed: ${response.status}`);
    }

    return response.json() as Promise<PayPalCaptureResponse>;
  }

  async getOrder(
    paypalOrderId: string,
    clientId: string,
    clientSecret: string,
  ): Promise<PayPalOrderResponse> {
    const accessToken = await this.getAccessToken(clientId, clientSecret);

    const response = await fetch(`${this.baseUrl}/v2/checkout/orders/${paypalOrderId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`PayPal get order failed: ${response.status}`);
    }

    return response.json() as Promise<PayPalOrderResponse>;
  }
}
