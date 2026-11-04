import {
  MIN_EXPORT_OFFER_DAYS,
  exportOfferHonoured,
  loadRetentionConfig,
  monthsBefore,
} from './retention.config';

const DAY = 24 * 60 * 60 * 1000;

describe('loadRetentionConfig', () => {
  it('uses the periods from the contract documents by default', () => {
    expect(
      loadRetentionConfig({
        NODE_ENV: 'production',
        RETENTION_DRY_RUN: 'false',
      }),
    ).toEqual({
      enabled: true,
      dryRun: false,
      categories: [],
      guestDataDays: 30,
      helperDataDays: 30,
      auditLogDays: 90,
      staleCredentialDays: 90,
      supportMonths: 12,
      contactMonths: 6,
      inactiveOrganizationMonths: 24,
      inactiveUserMonths: 24,
      noticeDays: 30,
      exportPeriodDays: 30,
      fiscalArchiveYears: 10,
      runLogYears: 3,
    });
  });

  it('only counts until real runs are switched on explicitly', () => {
    expect(loadRetentionConfig({}).dryRun).toBe(true);
    // Auch Staging laeuft mit NODE_ENV=production.
    expect(loadRetentionConfig({ NODE_ENV: 'production' }).dryRun).toBe(true);
    // Leer gesetzt (docker compose `${VAR:-}`) gilt wie nicht gesetzt.
    expect(
      loadRetentionConfig({ NODE_ENV: 'production', RETENTION_DRY_RUN: '' })
        .dryRun,
    ).toBe(true);
    expect(
      loadRetentionConfig({
        NODE_ENV: 'production',
        RETENTION_DRY_RUN: 'false',
      }).dryRun,
    ).toBe(false);
  });

  it('is off by default on self-hosted installations', () => {
    expect(loadRetentionConfig({ DEPLOYMENT_MODE: 'selfhosted' }).enabled).toBe(
      false,
    );
    expect(
      loadRetentionConfig({
        DEPLOYMENT_MODE: 'selfhosted',
        RETENTION_ENABLED: 'true',
      }).enabled,
    ).toBe(true);
  });

  it('never goes below the 30-day export offer for customer data', () => {
    const config = loadRetentionConfig({
      RETENTION_GUEST_DATA_DAYS: '1',
      RETENTION_HELPER_DATA_DAYS: '7',
      RETENTION_NOTICE_DAYS: '0',
      RETENTION_EXPORT_PERIOD_DAYS: '10',
      RETENTION_FISCAL_ARCHIVE_YEARS: '2',
    });
    expect(config.guestDataDays).toBe(MIN_EXPORT_OFFER_DAYS);
    expect(config.helperDataDays).toBe(MIN_EXPORT_OFFER_DAYS);
    expect(config.noticeDays).toBe(MIN_EXPORT_OFFER_DAYS);
    expect(config.exportPeriodDays).toBe(MIN_EXPORT_OFFER_DAYS);
    expect(config.fiscalArchiveYears).toBe(10);
  });

  it('accepts longer periods and a subset of categories', () => {
    const config = loadRetentionConfig({
      RETENTION_GUEST_DATA_DAYS: '60',
      RETENTION_CATEGORIES: 'guest_data, helper_data,unknown',
    });
    expect(config.guestDataDays).toBe(60);
    expect(config.categories).toEqual(['guest_data', 'helper_data']);
  });
});

describe('exportOfferHonoured', () => {
  const now = new Date('2026-11-04T03:30:00Z');

  it('requires a notice at least 30 days old', () => {
    expect(exportOfferHonoured(null, now, 30)).toBe(false);
    expect(
      exportOfferHonoured(new Date(now.getTime() - 29 * DAY), now, 30),
    ).toBe(false);
    expect(
      exportOfferHonoured(new Date(now.getTime() - 30 * DAY), now, 30),
    ).toBe(true);
  });

  it('cannot be shortened below 30 days', () => {
    expect(
      exportOfferHonoured(new Date(now.getTime() - 10 * DAY), now, 5),
    ).toBe(false);
  });

  it('honours a longer notice period', () => {
    expect(
      exportOfferHonoured(new Date(now.getTime() - 40 * DAY), now, 45),
    ).toBe(false);
  });
});

describe('monthsBefore', () => {
  it('goes back calendar months', () => {
    expect(
      monthsBefore(new Date('2026-11-04T00:00:00Z'), 24).toISOString(),
    ).toBe('2024-11-04T00:00:00.000Z');
  });
});
