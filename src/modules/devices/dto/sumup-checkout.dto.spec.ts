import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { DeviceSumupCheckoutDto } from './sumup-checkout.dto';

async function errors(body: Record<string, unknown>) {
  const dto = plainToInstance(DeviceSumupCheckoutDto, body);
  return (await validate(dto)).map((e) => e.property);
}

describe('DeviceSumupCheckoutDto', () => {
  it('accepts what the till sends', async () => {
    expect(await errors({ amount: 12.3, currency: 'EUR' })).toEqual([]);
    expect(await errors({ amount: 0.1 + 0.2 })).toEqual([]);
  });

  it('rejects zero, negative and non-numeric amounts', async () => {
    expect(await errors({ amount: 0 })).toEqual(['amount']);
    expect(await errors({ amount: -5 })).toEqual(['amount']);
    expect(await errors({ amount: '12' })).toEqual(['amount']);
  });

  it('rejects malformed currencies', async () => {
    expect(await errors({ amount: 5, currency: 'euro' })).toEqual(['currency']);
  });
});
