import { BadRequestException } from '@nestjs/common';

import { ErrorReasons } from '../../../common/constants/error-codes';
import {
  DEDICATED_ORGANIZATION_SETTINGS,
  filterOrganizationSettingsUpdate,
  orderFlowReferences,
} from './organization-settings-update';

const stored = {
  currency: 'EUR',
  timezone: 'Europe/Berlin',
  locale: 'de',
  assistant: { enabled: false },
  integrations: { tse: { enabled: false }, sumup: { enabled: true } },
  vatStatusHistory: [{ vatExempt: true, at: '2026-01-01' }],
  legacyThing: { a: 1 },
};

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return ((error as BadRequestException).getResponse() as { reason: string })
      .reason;
  }
  return undefined;
}

describe('organization settings update', () => {
  it('keeps the sections that belong to the general settings', () => {
    const incoming = {
      currency: 'CHF',
      timezone: 'Europe/Zurich',
      contact: { email: 'verein@example.com' },
      orderFlow: { receiptPrinting: { enabled: false } },
    };
    expect(filterOrganizationSettingsUpdate({ ...incoming }, stored)).toEqual(
      incoming,
    );
  });

  it('drops sections that come back unchanged, in any key order', () => {
    const incoming: Record<string, unknown> = {
      ...stored,
      integrations: { sumup: { enabled: true }, tse: { enabled: false } },
      currency: 'EUR',
    };
    const result = filterOrganizationSettingsUpdate(incoming, stored);
    expect(result).toEqual({
      currency: 'EUR',
      timezone: 'Europe/Berlin',
      locale: 'de',
    });
  });

  it.each(DEDICATED_ORGANIZATION_SETTINGS.map((key) => [key]))(
    'rejects changes to %s',
    (key) => {
      expect(
        reasonOf(() =>
          filterOrganizationSettingsUpdate(
            { [key]: { enabled: true } },
            stored,
          ),
        ),
      ).toBe(ErrorReasons.ORGANIZATION_SETTING_NOT_UPDATABLE);
    },
  );

  it('rejects turning on the cloud TSE through the settings', () => {
    expect(
      reasonOf(() =>
        filterOrganizationSettingsUpdate(
          { integrations: { ...stored.integrations, tse: { enabled: true } } },
          stored,
        ),
      ),
    ).toBe(ErrorReasons.ORGANIZATION_SETTING_NOT_UPDATABLE);
  });

  it('rejects unknown sections with a new value', () => {
    expect(
      reasonOf(() =>
        filterOrganizationSettingsUpdate({ somethingElse: true }, stored),
      ),
    ).toBe(ErrorReasons.ORGANIZATION_SETTING_NOT_UPDATABLE);
    expect(
      reasonOf(() =>
        filterOrganizationSettingsUpdate({ legacyThing: { a: 2 } }, stored),
      ),
    ).toBe(ErrorReasons.ORGANIZATION_SETTING_NOT_UPDATABLE);
  });

  it.each([
    ['currency', 'euro'],
    ['timezone', 'Mars/Olympus'],
    ['locale', 'deutsch'],
    ['vatExempt', 'yes'],
    ['contact', 'verein@example.com'],
    ['orderFlow', ['a']],
    ['description', 'x'.repeat(2001)],
    ['legal', { privacyText: 'x'.repeat(40_000) }],
  ])('rejects an invalid %s', (key, value) => {
    expect(
      reasonOf(() =>
        filterOrganizationSettingsUpdate({ [key]: value }, stored),
      ),
    ).toBe(ErrorReasons.ORGANIZATION_SETTINGS_INVALID);
  });

  it('accepts no settings at all', () => {
    expect(filterOrganizationSettingsUpdate(undefined, stored)).toBeUndefined();
  });

  it('collects printer and template references of the order flow', () => {
    expect(
      orderFlowReferences({
        receiptPrinting: { printerId: 'p1', templateId: 't1' },
        kitchenTicketPrinting: { printerId: 'p1', templateId: null },
        orderTicketPrinting: { printerId: 'p2' },
        kitchenDisplay: { enabled: true },
      }),
    ).toEqual({ printerIds: ['p1', 'p2'], templateIds: ['t1'] });
  });
});
