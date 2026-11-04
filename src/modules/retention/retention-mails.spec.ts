import {
  organizationDeletionMail,
  organizationInactivityMail,
  userInactivityMail,
} from './retention-mails';

describe('retention mails', () => {
  const dueAt = new Date('2026-12-04T12:00:00Z');

  it('announces the closure with an export link (du-form)', () => {
    const mail = organizationInactivityMail({
      to: 'vorstand@verein.example',
      appUrl: 'https://app.example.test',
      organizationName: 'TSV <Musterdorf>',
      lastActivityAt: new Date('2024-10-01T12:00:00Z'),
      dueAt,
      inactiveMonths: 24,
      exportPeriodDays: 30,
    });
    expect(mail.subject).toBe(
      'Deine Organisation „TSV <Musterdorf>“ wird geschlossen',
    );
    expect(mail.html).toContain('https://app.example.test/reports');
    expect(mail.html).toContain('TSV &lt;Musterdorf&gt;');
    expect(mail.html).not.toContain('TSV <Musterdorf>');
    expect(mail.text).toContain('4. Dezember 2026');
    expect(mail.text).toContain('kannst du');
    expect(mail.text).toContain('zehn Jahren');
    expect(mail.text).not.toMatch(/\bSie\b|\bIhre?\b/);
  });

  it('announces the final deletion with a way to request an export', () => {
    const mail = organizationDeletionMail({
      to: 'vorstand@verein.example',
      appUrl: 'https://app.example.test',
      organizationName: 'TSV Musterdorf',
      deletedAt: new Date('2026-11-01T12:00:00Z'),
      closedForInactivity: false,
      dueAt,
      contactEmail: 'export@example.test',
    });
    expect(mail.subject).toContain('Endgültige Löschung');
    expect(mail.html).toContain('mailto:export@example.test');
    expect(mail.text).toContain('gelöscht');
    expect(mail.text).toContain('Steuerarchiv');

    const closed = organizationDeletionMail({
      to: 'vorstand@verein.example',
      appUrl: 'https://app.example.test',
      organizationName: 'TSV Musterdorf',
      deletedAt: new Date('2026-11-01T12:00:00Z'),
      closedForInactivity: true,
      dueAt,
      contactEmail: null,
    });
    expect(closed.text).toContain('lange nicht genutzt');
    expect(closed.html).not.toContain('mailto:');
  });

  it('asks idle users to log in to keep their account', () => {
    const mail = userInactivityMail({
      to: 'erika@example.test',
      appUrl: 'https://app.example.test',
      inactiveMonths: 24,
      dueAt,
    });
    expect(mail.subject).toBe('Dein OpenEOS-Konto wird gelöscht');
    expect(mail.html).toContain('https://app.example.test/login');
    expect(mail.text).toContain('melde dich');
  });
});
