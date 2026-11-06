import {
  accountDeletedMail,
  accountDeletionScheduledMail,
  organizationDeletionMail,
  organizationDeletionReminderMail,
  organizationInactivityMail,
  organizationInactivityReminderMail,
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

  it('announces the final deletion with the in-app export, cancelling and the reminder plan', () => {
    const mail = organizationDeletionMail({
      to: 'vorstand@verein.example',
      appUrl: 'https://app.example.test',
      organizationName: 'TSV Musterdorf',
      deletedAt: new Date('2026-11-01T12:00:00Z'),
      closedForInactivity: false,
      dueAt,
      contactEmail: 'export@example.test',
    });
    expect(mail.subject).toBe(
      'Endgültige Löschung deiner Organisation „TSV Musterdorf“',
    );
    expect(mail.html).toContain('https://app.example.test/reports');
    expect(mail.text).toContain('Ab dem 4. Dezember 2026 löschen wir');
    expect(mail.text).toContain('nur noch lesend');
    expect(mail.text).toContain('„Löschung abbrechen“');
    expect(mail.text).toContain('Steuerarchiv');
    expect(mail.text).toContain('zehn Tage und einen Tag vorher');
    expect(mail.text).toContain('export@example.test');
    expect(mail.text).not.toMatch(/\bSie\b|\bIhre?\b/);

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
    expect(closed.text).not.toContain('Schreib uns');
  });

  it('reminds 10 days and 1 day before the final deletion', () => {
    const base = {
      to: 'vorstand@verein.example',
      appUrl: 'https://app.example.test',
      organizationName: 'TSV Musterdorf',
      deletedAt: new Date('2026-11-01T12:00:00Z'),
      closedForInactivity: false,
      dueAt,
      contactEmail: null,
    };
    const ten = organizationDeletionReminderMail({ ...base, daysLeft: 10 });
    expect(ten.subject).toBe(
      'Erinnerung: „TSV Musterdorf“ wird in 10 Tagen endgültig gelöscht',
    );
    expect(ten.text).toContain('(in 10 Tagen)');
    expect(ten.text).toContain('https://app.example.test/reports');
    expect(ten.text).toContain('Löschung abbrechen');
    expect(ten.text).toContain('zehn Jahren');
    // Erinnerungen kuendigen keine weiteren Erinnerungen an.
    expect(ten.text).not.toContain('erinnern dich');
    const one = organizationDeletionReminderMail({ ...base, daysLeft: 1 });
    expect(one.subject).toBe(
      'Erinnerung: „TSV Musterdorf“ wird morgen endgültig gelöscht',
    );
  });

  it('reminds before the closure for inactivity', () => {
    const mail = organizationInactivityReminderMail({
      to: 'vorstand@verein.example',
      appUrl: 'https://app.example.test',
      organizationName: 'TSV Musterdorf',
      dueAt,
      daysLeft: 10,
      exportPeriodDays: 30,
    });
    expect(mail.subject).toBe(
      'Erinnerung: Deine Organisation „TSV Musterdorf“ wird in 10 Tagen geschlossen',
    );
    expect(mail.text).toContain('buche bis dahin eine Veranstaltung');
    expect(mail.text).toContain('30 Tage nur lesend');
    expect(mail.text).toContain('https://app.example.test/reports');
  });

  it('confirms and reminds a scheduled account deletion with its organizations', () => {
    const o = {
      to: 'erika@example.test',
      appUrl: 'https://app.example.test',
      organizations: ['TSV Musterdorf'],
      requestedAt: new Date('2026-11-04T12:00:00Z'),
      dueAt,
    };
    const confirm = accountDeletionScheduledMail(o);
    expect(confirm.subject).toBe(
      'Dein OpenEOS-Konto wird am 4. Dezember 2026 gelöscht',
    );
    expect(confirm.text).toContain('einzige Mitglied von „TSV Musterdorf“');
    expect(confirm.text).toContain('wird die Organisation mitgelöscht');
    expect(confirm.text).toContain('„Löschung abbrechen“');
    expect(confirm.text).toContain('beitreten');
    expect(confirm.text).toContain('zehn Tage und einen Tag vorher');
    expect(confirm.html).toContain('https://app.example.test/reports');

    const reminder = accountDeletionScheduledMail({
      ...o,
      organizations: ['A', 'B'],
      daysLeft: 1,
    });
    expect(reminder.subject).toBe(
      'Erinnerung: Dein OpenEOS-Konto wird morgen endgültig gelöscht',
    );
    expect(reminder.text).toContain('werden diese Organisationen mitgelöscht');
    expect(reminder.text).not.toContain('erinnern dich');

    const done = accountDeletedMail({
      to: 'erika@example.test',
      appUrl: 'https://app.example.test',
      deletedAt: dueAt,
      purgedOrganizations: ['TSV Musterdorf'],
    });
    expect(done.text).toContain('Wie angekündigt');
    expect(done.text).toContain('„TSV Musterdorf“');
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
