import { ConfigService } from '@nestjs/config';

import type { Organization } from '../../database/entities/organization.entity';
import type { User } from '../../database/entities/user.entity';
import { validationSchema } from '../../config/validation.schema';
import { TseAutoActivationService } from './tse-auto-activation.service';
import {
  TseConfig,
  parseTseComingSoon,
  tseAvailabilityOf,
  tseNotAvailableMessage,
} from './tse.config';
import { TseStatusService } from './tse-status.service';

/**
 * „Bald verfuegbar“ (TSE_COMING_SOON): gehostet ohne Swissbit-Vertrag meldet
 * der Server die Cloud-TSE als angekuendigt statt als „nicht eingerichtet“.
 * Eigene Installationen ignorieren den Wert.
 */

const SWISSBIT = {
  TSE_PROVIDER: 'swissbit',
  SWISSBIT_CREDIT_CLIENT_ID: 'credit-id',
  SWISSBIT_CREDIT_CLIENT_SECRET: 'credit-secret',
  SWISSBIT_PRODUCT_TYPE: '850007',
};

function tseConfig(
  env: Record<string, string | boolean | undefined>,
  mode: 'saas' | 'selfhosted' = 'saas',
): TseConfig {
  const values: Record<string, unknown> = { ...env, 'deployment.mode': mode };
  return new TseConfig({
    get: (key: string) => values[key],
  } as unknown as ConfigService);
}

describe('tseAvailabilityOf', () => {
  it.each([
    [true, false, false, 'available'],
    [true, true, false, 'available'],
    [true, true, true, 'available'],
    [false, true, false, 'coming_soon'],
    [false, true, true, 'not_configured'],
    [false, false, false, 'not_configured'],
    [false, false, true, 'not_configured'],
  ] as const)(
    'enabled=%s comingSoon=%s selfHosted=%s → %s',
    (enabled, comingSoon, selfHosted, expected) => {
      expect(tseAvailabilityOf({ enabled, comingSoon, selfHosted })).toBe(
        expected,
      );
    },
  );

  it('only an explicit true switches the flag on', () => {
    expect(parseTseComingSoon('true')).toBe(true);
    expect(parseTseComingSoon(' TRUE ')).toBe(true);
    expect(parseTseComingSoon('false')).toBe(false);
    expect(parseTseComingSoon('')).toBe(false);
    expect(parseTseComingSoon(undefined)).toBe(false);
    expect(parseTseComingSoon('1')).toBe(false);
  });
});

describe('TSE_COMING_SOON env validation', () => {
  const validate = (value: string | undefined) =>
    validationSchema.validate(
      { JWT_SECRET: 'x'.repeat(40), TSE_COMING_SOON: value },
      { allowUnknown: true },
    );

  it('accepts true/false/empty (compose `${TSE_COMING_SOON:-}`) and defaults to false', () => {
    expect(validate('true').error).toBeUndefined();
    expect(validate('True').error).toBeUndefined();
    expect(validate('false').error).toBeUndefined();
    expect(validate('').error).toBeUndefined();
    const { value } = validate(undefined) as { value: Record<string, unknown> };
    expect(value.TSE_COMING_SOON).toBe('false');
  });

  it('rejects anything else', () => {
    expect(validate('yes').error?.message).toMatch(/TSE_COMING_SOON/);
  });
});

describe('TseConfig.availability', () => {
  it('hosted without provider + TSE_COMING_SOON=true → coming_soon', () => {
    const config = tseConfig({ TSE_PROVIDER: 'none', TSE_COMING_SOON: 'true' });
    expect(config.enabled).toBe(false);
    expect(config.comingSoon).toBe(true);
    expect(config.availability).toBe('coming_soon');
  });

  it('a boolean from the config service counts as well', () => {
    expect(tseConfig({ TSE_COMING_SOON: true }).availability).toBe(
      'coming_soon',
    );
  });

  it('without the flag (default) → not_configured', () => {
    expect(tseConfig({ TSE_PROVIDER: 'none' }).availability).toBe(
      'not_configured',
    );
    expect(
      tseConfig({ TSE_PROVIDER: 'none', TSE_COMING_SOON: 'false' })
        .availability,
    ).toBe('not_configured');
  });

  it('self-hosted ignores the flag', () => {
    expect(
      tseConfig({ TSE_PROVIDER: 'none', TSE_COMING_SOON: 'true' }, 'selfhosted')
        .availability,
    ).toBe('not_configured');
  });

  it('a configured provider is available, the flag does not matter', () => {
    expect(
      tseConfig({ ...SWISSBIT, TSE_COMING_SOON: 'true' }).availability,
    ).toBe('available');
    expect(tseConfig(SWISSBIT).availability).toBe('available');
  });

  it('503 message says „bald verfügbar“ only when coming soon', () => {
    expect(tseNotAvailableMessage('coming_soon')).toMatch(/bald verfügbar/);
    expect(tseNotAvailableMessage('not_configured')).toBe(
      'Auf diesem Server ist keine Cloud-TSE eingerichtet',
    );
  });
});

describe('GET /organizations/:id/tse → availability', () => {
  const organization = {
    id: 'org-1',
    country: 'DE',
    settings: {},
  } as unknown as Organization;

  function statusService(config: TseConfig) {
    const units = {
      assertAdmin: jest.fn(() => Promise.resolve(organization)),
      eligibility: jest.fn(() =>
        Promise.resolve({
          ok: false,
          reason: 'TSE_NOT_AVAILABLE',
          availableFrom: null,
          event: null,
          qualifying: null,
        }),
      ),
      history: jest.fn(() => Promise.resolve([])),
      findLatest: jest.fn(() => Promise.resolve(null)),
    };
    const exports = {
      lastDownloaded: jest.fn(() => Promise.resolve(null)),
      pendingCount: jest.fn(() => Promise.resolve(0)),
    };
    return new TseStatusService(
      {} as never,
      {} as never,
      config,
      units as never,
      {} as never,
      exports as never,
      {} as never,
    );
  }

  it.each([
    ['coming_soon', { TSE_COMING_SOON: 'true' }, 'saas', false],
    ['not_configured', {}, 'saas', false],
    ['not_configured', { TSE_COMING_SOON: 'true' }, 'selfhosted', false],
    ['available', SWISSBIT, 'saas', true],
  ] as const)('reports %s', async (availability, env, mode, available) => {
    const service = statusService(tseConfig(env, mode));
    const status = await service.status('org-1', {} as User);
    expect(status).toMatchObject({ available, availability });
    // Kurzfassung in GET /organizations/:id (`tse`) meldet dasselbe.
    expect(await service.summary(organization)).toMatchObject({
      available,
      availability,
    });
  });
});

describe('checkout terms while the Cloud-TSE is coming soon', () => {
  function terms(org: Partial<Organization>, env: Record<string, string>) {
    const config = tseConfig(env);
    const service = new TseAutoActivationService(
      {} as never,
      config,
      {} as never,
      {} as never,
      { get: () => 0 } as unknown as ConfigService,
    );
    return service.checkoutTerms(org as Organization);
  }

  const legacy = {
    country: 'DE',
    operatingMode: 'full',
    operatingModeLegacy: true,
    settings: {},
  } as Partial<Organization>;

  it('no TSE question, but a coming-soon note for German full/legacy organizations', () => {
    expect(terms(legacy, { TSE_COMING_SOON: 'true' })).toEqual({
      offer: null,
      surcharge: 0,
      missing: [],
      comingSoon: true,
    });
    expect(
      terms(
        { ...legacy, operatingModeLegacy: false },
        { TSE_COMING_SOON: 'true' },
      ),
    ).toMatchObject({ offer: null, comingSoon: true });
  });

  it('not for cashless, other countries or without the flag', () => {
    expect(
      terms(
        { ...legacy, operatingMode: 'cashless', operatingModeLegacy: false },
        { TSE_COMING_SOON: 'true' },
      ),
    ).toMatchObject({ offer: null, comingSoon: false });
    expect(
      terms({ ...legacy, country: 'AT' }, { TSE_COMING_SOON: 'true' }),
    ).toMatchObject({ offer: null, comingSoon: false });
    expect(terms(legacy, {})).toMatchObject({ offer: null, comingSoon: false });
  });

  it('with the provider configured the question comes back', () => {
    expect(
      terms(legacy, { ...SWISSBIT, TSE_COMING_SOON: 'true' }),
    ).toMatchObject({ offer: 'optional', comingSoon: false });
  });
});
