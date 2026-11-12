import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateOnlinePaymentDto } from '../../online-orders/dto/create-online-payment.dto';
import { CreatePaymentDto, DIRECT_PAYMENT_METHODS } from './create-payment.dto';
import { SplitPaymentDto } from './split-payment.dto';

/**
 * PayPal ist seit 1.8 entfernt: Der Wert `paypal` bleibt nur fuer fruehere
 * Zahlungen im Enum (Berichte, Exporte, DSFinV-K) — neu buchen laesst er
 * sich ueber keinen Eingang.
 */
describe('payment method input without PayPal', () => {
  it('direct and split payments do not accept paypal', async () => {
    expect(DIRECT_PAYMENT_METHODS).not.toContain('paypal');

    const direct = plainToInstance(CreatePaymentDto, {
      orderId: '550e8400-e29b-41d4-a716-446655440000',
      amount: 10,
      paymentMethod: 'paypal',
    });
    const errors = await validate(direct);
    expect(errors.map((e) => e.property)).toContain('paymentMethod');

    const split = plainToInstance(SplitPaymentDto, {
      orderId: '550e8400-e29b-41d4-a716-446655440000',
      amount: 10,
      paymentMethod: 'paypal',
      items: [],
    });
    const splitErrors = await validate(split);
    expect(splitErrors.map((e) => e.property)).toContain('paymentMethod');
  });

  it('QR order payment does not accept paypal, SumUp Online still does', async () => {
    const paypal = await validate(
      plainToInstance(CreateOnlinePaymentDto, { paymentMethod: 'paypal' }),
    );
    expect(paypal.map((e) => e.property)).toContain('paymentMethod');

    for (const method of ['sumup_online', 'google_pay', 'apple_pay']) {
      const ok = await validate(
        plainToInstance(CreateOnlinePaymentDto, { paymentMethod: method }),
      );
      expect(ok).toEqual([]);
    }
  });
});
