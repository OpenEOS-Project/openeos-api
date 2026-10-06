import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { PlatformSetting } from '../../database/entities';
import { PlatformSettingsService } from './platform-settings.service';

/**
 * Empfaenger der Admin-Benachrichtigungen: Support-Nachrichten und
 * Kontaktanfragen gehen bevorzugt an SUPPORT_NOTIFY_EMAIL, alles andere an
 * die allgemeine Admin-Adresse.
 */
describe('PlatformSettingsService.resolveNotificationTarget', () => {
  function build(options: {
    supportEmail?: string;
    adminEmail?: string;
    stored?: Record<string, unknown> | null;
  }): PlatformSettingsService {
    const repo = {
      findOne: jest
        .fn()
        .mockResolvedValue(options.stored ? { value: options.stored } : null),
    } as unknown as Repository<PlatformSetting>;
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'support.notifyEmail') return options.supportEmail ?? '';
        if (key === 'email.adminNotifyEmail') return options.adminEmail ?? '';
        return undefined;
      }),
    } as unknown as ConfigService;
    return new PlatformSettingsService(repo, config);
  }

  it('sends support messages and contact requests to SUPPORT_NOTIFY_EMAIL', async () => {
    const service = build({
      supportEmail: 'support@example.com',
      adminEmail: 'admin@example.com',
      stored: { email: 'settings@example.com' },
    });

    await expect(
      service.resolveNotificationTarget('supportMessage'),
    ).resolves.toBe('support@example.com');
    await expect(
      service.resolveNotificationTarget('contactRequest'),
    ).resolves.toBe('support@example.com');
  });

  it('keeps other notifications on the general admin address', async () => {
    const service = build({
      supportEmail: 'support@example.com',
      adminEmail: 'admin@example.com',
    });

    await expect(
      service.resolveNotificationTarget('userRegistered'),
    ).resolves.toBe('admin@example.com');
  });

  it('falls back to the general admin address without SUPPORT_NOTIFY_EMAIL', async () => {
    const service = build({ stored: { email: 'settings@example.com' } });

    await expect(
      service.resolveNotificationTarget('contactRequest'),
    ).resolves.toBe('settings@example.com');
  });

  it('sends nothing if no address is configured at all', async () => {
    const service = build({});

    await expect(
      service.resolveNotificationTarget('contactRequest'),
    ).resolves.toBeNull();
  });

  it('respects a disabled toggle even with SUPPORT_NOTIFY_EMAIL', async () => {
    const service = build({
      supportEmail: 'support@example.com',
      stored: { notifyOn: { supportMessage: false } },
    });

    await expect(
      service.resolveNotificationTarget('supportMessage'),
    ).resolves.toBeNull();
  });
});
