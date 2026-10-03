import { ForbiddenException } from '@nestjs/common';
import {
  INTEGRATION_IDS,
  assertIntegrationEnabled,
  isIntegrationEnabled,
  isKnownIntegration,
} from './integration-catalog';

describe('integration catalog', () => {
  it('lists sumup as a known integration', () => {
    expect(INTEGRATION_IDS).toContain('sumup');
    expect(isKnownIntegration('sumup')).toBe(true);
    expect(isKnownIntegration('unknown')).toBe(false);
    expect(isKnownIntegration('__proto__')).toBe(false);
  });
});

describe('isIntegrationEnabled', () => {
  it('is true only for an explicit enabled === true', () => {
    expect(
      isIntegrationEnabled(
        { integrations: { sumup: { enabled: true } } },
        'sumup',
      ),
    ).toBe(true);
  });

  it.each([
    ['settings missing', undefined],
    ['settings null', null],
    ['no integrations block', { sumup: { apiKey: 'k', merchantCode: 'M' } }],
    ['integrations null', { integrations: null }],
    ['integrations not an object', { integrations: 'sumup' }],
    ['entry missing', { integrations: { other: { enabled: true } } }],
    ['entry disabled', { integrations: { sumup: { enabled: false } } }],
    ['enabled as string', { integrations: { sumup: { enabled: 'true' } } }],
    ['enabled as 1', { integrations: { sumup: { enabled: 1 } } }],
  ])('is false when %s', (_label, settings) => {
    expect(isIntegrationEnabled(settings, 'sumup')).toBe(false);
  });
});

describe('assertIntegrationEnabled', () => {
  it('passes when the integration is enabled', () => {
    expect(() =>
      assertIntegrationEnabled(
        { integrations: { sumup: { enabled: true } } },
        'sumup',
      ),
    ).not.toThrow();
  });

  it('throws 403 INTEGRATION_DISABLED otherwise', () => {
    let caught: unknown;
    try {
      assertIntegrationEnabled({}, 'sumup');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    const exception = caught as ForbiddenException;
    expect(exception.getStatus()).toBe(403);
    expect(exception.getResponse()).toMatchObject({
      code: 'INTEGRATION_DISABLED',
    });
  });
});
