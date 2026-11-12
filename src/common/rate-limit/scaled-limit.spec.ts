import { DevicesLinkController } from '../../modules/devices/devices-link.controller';
import { scaledLimit } from './scaled-limit';

describe('scaled endpoint limits', () => {
  const original = process.env.THROTTLE_LIMIT;
  afterEach(() => {
    if (original === undefined) delete process.env.THROTTLE_LIMIT;
    else process.env.THROTTLE_LIMIT = original;
  });

  it('keep the base value with the default global limit', () => {
    delete process.env.THROTTLE_LIMIT;
    expect(scaledLimit(20)()).toBe(20);
    process.env.THROTTLE_LIMIT = '300';
    expect(scaledLimit(20)()).toBe(20);
  });

  it('never drop below the base value', () => {
    process.env.THROTTLE_LIMIT = '50';
    expect(scaledLimit(20)()).toBe(20);
    process.env.THROTTLE_LIMIT = 'nonsense';
    expect(scaledLimit(20)()).toBe(20);
  });

  it('grow with a raised global limit', () => {
    process.env.THROTTLE_LIMIT = '600';
    expect(scaledLimit(20)()).toBe(40);
    process.env.THROTTLE_LIMIT = '100000';
    expect(scaledLimit(20)()).toBe(6667);
  });

  it('are used for linking devices', () => {
    const limit = Reflect.getMetadata(
      'THROTTLER:LIMITdefault',
      Object.getOwnPropertyDescriptor(
        DevicesLinkController.prototype,
        'linkDevice',
      )!.value as object,
    ) as () => number;
    delete process.env.THROTTLE_LIMIT;
    expect(typeof limit).toBe('function');
    expect(limit()).toBe(20);
  });
});
