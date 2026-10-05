import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorReasons } from '../../../common/constants/error-codes';

interface PayPalOrderResponse {
  id: string;
  status: string;
  links: { href: string; rel: string; method: string }[];
}

interface PayPalCaptureResponse {
  id: string;
  status: string;
  purchase_units: {
    payments: { captures: { id: string; amount: { value: string } }[] };
  }[];
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

  private async getAccessToken(
    clientId: string,
    clientSecret: string,
  ): Promise<string> {
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

    const data = (await response.json()) as { access_token: string };
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
        purchase_units: [
          {
            amount: {
              currency_code: currency,
              value: amount.toFixed(2),
            },
            description,
          },
        ],
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

  /**
   * Prueft die Bestellnummer, bevor sie in eine URL wandert.
   *
   * Sie kommt aus der Anfrage des Kunden und landete bisher ungeprueft im
   * Pfad. Ein Wert mit `/`, `?` oder `..` haette die Anfrage damit auf einen
   * anderen Endpunkt umgelenkt, als hier gemeint ist — mit dem gueltigen
   * Zugangstoken der Organisation im Gepaeck.
   *
   * PayPal vergibt Kennungen aus Grossbuchstaben und Ziffern. Alles, was
   * nicht so aussieht, ist kein Auftrag von PayPal.
   *
   * Zusaetzlich wird der Wert beim Einsetzen kodiert. Die Pruefung allein
   * genuegte zwar, aber sie steht an anderer Stelle als die Verwendung —
   * die Kodierung schuetzt auch dann noch, wenn jemand spaeter eine dritte
   * Abfrage ergaenzt und den Aufruf hier vergisst.
   */
  private assertSafeOrderId(paypalOrderId: string): void {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(paypalOrderId)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        reason: ErrorReasons.PAYPAL_ORDER_ID_INVALID,
        message: 'Ungültige PayPal-Bestellnummer',
      });
    }
  }

  async captureOrder(
    paypalOrderId: string,
    clientId: string,
    clientSecret: string,
  ): Promise<PayPalCaptureResponse> {
    this.assertSafeOrderId(paypalOrderId);
    const accessToken = await this.getAccessToken(clientId, clientSecret);

    const response = await fetch(
      `${this.baseUrl}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

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
    this.assertSafeOrderId(paypalOrderId);
    const accessToken = await this.getAccessToken(clientId, clientSecret);

    const response = await fetch(
      `${this.baseUrl}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`PayPal get order failed: ${response.status}`);
    }

    return response.json() as Promise<PayPalOrderResponse>;
  }
}
