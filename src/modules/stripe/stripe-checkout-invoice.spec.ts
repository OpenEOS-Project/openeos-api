import { ConfigService } from '@nestjs/config';

import { VAT_EXEMPT_NOTE } from '../../common/constants/billing-text';
import { StripeService } from './stripe.service';

/*
 * Rechnungen aus der Stripe-Zahlungsseite (Karte/Lastschrift) tragen den
 * Hinweis nach § 19 UStG in der Fusszeile — wie die Rechnungen
 * „auf Rechnung“.
 */
describe('StripeService.createCheckoutSession — invoice footer', () => {
  it('puts the § 19 UStG note on the checkout invoice', async () => {
    const create = jest.fn(() =>
      Promise.resolve({ id: 'cs_1', url: 'https://checkout.stripe.test/1' }),
    );
    const service = new StripeService(new ConfigService({}));
    (service as unknown as { client: unknown }).client = {
      checkout: { sessions: { create } },
    };

    await service.createCheckoutSession({
      customerId: 'cus_1',
      amountInCents: 5000,
      currency: 'EUR',
      productName: 'Freischaltung',
      productDescription: '2 Event-Tage',
      successUrl: 'https://app.test/ok',
      cancelUrl: 'https://app.test/cancel',
      metadata: {},
      idempotencyKey: 'k1',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice_creation: {
          enabled: true,
          invoice_data: { footer: VAT_EXEMPT_NOTE },
        },
      }),
      { idempotencyKey: 'k1' },
    );
  });
});
