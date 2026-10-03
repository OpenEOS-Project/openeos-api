import * as crypto from 'crypto';

import { DevicesService } from '../devices/devices.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { SetupService } from '../setup/setup.service';
import { AuthService } from './auth.service';
import { TwoFactorService } from './two-factor.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

jest.mock('crypto', () => {
  const actual = jest.requireActual<typeof import('crypto')>('crypto');
  return { ...actual, randomInt: jest.fn(actual.randomInt) };
});

type Generator = () => string;

/** Call a private generator that does not use `this`. */
function privateGenerator(prototype: object, name: string): Generator {
  const fn = (prototype as Record<string, (this: void) => string>)[name];
  return () => fn.call(undefined);
}

describe.each([
  [
    'AuthService',
    privateGenerator(AuthService.prototype, 'generateSupportPin'),
  ],
  [
    'OrganizationsService',
    privateGenerator(OrganizationsService.prototype, 'generateSupportPin'),
  ],
  [
    'SetupService',
    privateGenerator(SetupService.prototype, 'generateSupportPin'),
  ],
])('%s.generateSupportPin', (_name, generate) => {
  afterEach(() => jest.mocked(crypto.randomInt).mockClear());

  it('keeps the six-digit format and draws from crypto.randomInt', () => {
    for (let i = 0; i < 50; i += 1) {
      const pin = generate();
      expect(pin).toMatch(/^[1-9]\d{5}$/);
    }
    expect(crypto.randomInt).toHaveBeenCalledWith(100000, 1000000);
  });
});

describe('DevicesService.generateVerificationCode', () => {
  it('keeps the six-digit format and draws from crypto.randomInt', async () => {
    jest.mocked(crypto.randomInt).mockClear();
    const self = {
      deviceRepository: { findOne: jest.fn(() => Promise.resolve(null)) },
    };
    const generate = (
      DevicesService.prototype as unknown as {
        generateVerificationCode: (this: unknown) => Promise<string>;
      }
    ).generateVerificationCode;

    const code = await generate.call(self);

    expect(code).toMatch(/^[1-9]\d{5}$/);
    expect(crypto.randomInt).toHaveBeenCalledWith(100000, 1000000);
  });
});

describe('TwoFactorService.generateNumericCode', () => {
  it('returns the requested number of digits from crypto.randomInt', () => {
    jest.mocked(crypto.randomInt).mockClear();
    const generate = (
      TwoFactorService.prototype as unknown as {
        generateNumericCode: (this: void, length: number) => string;
      }
    ).generateNumericCode;

    expect(generate(6)).toMatch(/^\d{6}$/);
    expect(generate(8)).toMatch(/^\d{8}$/);
    expect(crypto.randomInt).toHaveBeenCalledTimes(14);
    expect(crypto.randomInt).toHaveBeenCalledWith(10);
  });
});
