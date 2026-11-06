import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';

import type { User } from '../../database/entities';
import {
  isNewsletterSubscribed,
  newsletterUnsubscribeToken,
  newsletterUnsubscribeUrl,
  verifyNewsletterUnsubscribeToken,
} from './newsletter-token';
import { NewsletterService } from './newsletter.service';

const USER = '0b6f8a2e-3c1d-4e5f-9a7b-1c2d3e4f5a6b';
const SECRET = 'test-secret';

describe('newsletter unsubscribe token', () => {
  it('round-trips and rejects tampering or a different secret', () => {
    const token = newsletterUnsubscribeToken(USER, SECRET);
    expect(verifyNewsletterUnsubscribeToken(token, SECRET)).toBe(USER);
    expect(verifyNewsletterUnsubscribeToken(token, 'other')).toBeNull();
    const other = '1b6f8a2e-3c1d-4e5f-9a7b-1c2d3e4f5a6b';
    expect(
      verifyNewsletterUnsubscribeToken(
        `${other}.${token.split('.')[1]}`,
        SECRET,
      ),
    ).toBeNull();
    expect(verifyNewsletterUnsubscribeToken(`${token}x`, SECRET)).toBeNull();
    expect(verifyNewsletterUnsubscribeToken('garbage', SECRET)).toBeNull();
    expect(verifyNewsletterUnsubscribeToken(undefined, SECRET)).toBeNull();
    expect(verifyNewsletterUnsubscribeToken([token, token], SECRET)).toBeNull();
  });

  it('builds the link for mails', () => {
    expect(newsletterUnsubscribeUrl('https://app.example/', USER, SECRET)).toBe(
      `https://app.example/newsletter/abmelden?token=${encodeURIComponent(newsletterUnsubscribeToken(USER, SECRET))}`,
    );
  });

  it('is subscribed only with a consent newer than the withdrawal', () => {
    const t = (d: string) => new Date(d);
    expect(
      isNewsletterSubscribed({
        newsletterOptInAt: null,
        newsletterOptOutAt: null,
      }),
    ).toBe(false);
    expect(
      isNewsletterSubscribed({
        newsletterOptInAt: t('2026-01-01'),
        newsletterOptOutAt: null,
      }),
    ).toBe(true);
    expect(
      isNewsletterSubscribed({
        newsletterOptInAt: t('2026-01-01'),
        newsletterOptOutAt: t('2026-02-01'),
      }),
    ).toBe(false);
    expect(
      isNewsletterSubscribed({
        newsletterOptInAt: t('2026-03-01'),
        newsletterOptOutAt: t('2026-02-01'),
      }),
    ).toBe(true);
  });
});

describe('NewsletterService', () => {
  function setup(user: Partial<User>) {
    const stored = { id: USER, ...user } as User;
    const repo = {
      findOneOrFail: jest.fn(() => Promise.resolve(stored)),
      findOne: jest.fn(() => Promise.resolve(stored)),
      update: jest.fn((_id: string, patch: Partial<User>) => {
        Object.assign(stored, patch);
        return Promise.resolve();
      }),
    };
    const config = {
      get: (key: string) => (key === 'jwt.secret' ? SECRET : undefined),
    } as unknown as ConfigService;
    const service = new NewsletterService(
      repo as unknown as Repository<User>,
      config,
    );
    return { service, repo, stored };
  }

  it('withdrawing keeps the consent timestamp as proof', async () => {
    const consented = new Date('2026-05-01T10:00:00Z');
    const { service, stored } = setup({
      newsletterOptInAt: consented,
      newsletterOptOutAt: null,
      emailVerifiedAt: new Date(),
    });
    const status = await service.set(USER, false);
    expect(status.subscribed).toBe(false);
    expect(stored.newsletterOptInAt).toBe(consented);
    expect(stored.newsletterOptOutAt).toBeInstanceOf(Date);
  });

  it('giving consent again sets a new consent timestamp, keeps the withdrawal', async () => {
    const withdrawn = new Date('2026-06-01T10:00:00Z');
    const { service, stored } = setup({
      newsletterOptInAt: new Date('2026-05-01T10:00:00Z'),
      newsletterOptOutAt: withdrawn,
    });
    const status = await service.set(USER, true);
    expect(status.subscribed).toBe(true);
    expect(stored.newsletterOptOutAt).toBe(withdrawn);
    expect(stored.newsletterOptInAt!.getTime()).toBeGreaterThan(
      withdrawn.getTime(),
    );
  });

  it('does not touch timestamps when nothing changes', async () => {
    const { service, repo } = setup({
      newsletterOptInAt: null,
      newsletterOptOutAt: null,
    });
    await service.set(USER, false);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('unsubscribes via a signed link and rejects invalid links', async () => {
    const { service, stored } = setup({
      newsletterOptInAt: new Date('2026-05-01T10:00:00Z'),
      newsletterOptOutAt: null,
    });
    await expect(service.unsubscribe('nope')).rejects.toMatchObject({
      response: { reason: 'NEWSLETTER_TOKEN_INVALID' },
    });
    await service.unsubscribe(newsletterUnsubscribeToken(USER, SECRET));
    expect(stored.newsletterOptOutAt).toBeInstanceOf(Date);
    expect(isNewsletterSubscribed(stored)).toBe(false);
    expect(service.unsubscribeUrl(USER)).toContain(
      '/newsletter/abmelden?token=',
    );
  });
});
