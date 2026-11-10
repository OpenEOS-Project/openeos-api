import { buildChecklist } from './event-checklist';
import {
  afterEventMail,
  dayBeforeMail,
  formatDeadline,
  formatMoment,
  notBookedMail,
  weekBeforeMail,
} from './event-notification-mails';

const TZ = 'Europe/Berlin';
const APP = 'https://app.example.org';
const FIRST_DAY = new Date('2026-11-16T05:00:00Z'); // 16.11. 6 Uhr
const base = {
  to: 'kassenwart@example.org',
  appUrl: APP,
  organizationName: 'TSV <Musterstadt>',
  eventName: 'Herbstfest & Kerwe',
  timeZone: TZ,
  firstDay: FIRST_DAY,
};

describe('Formate', () => {
  it('formatMoment relativ zu heute', () => {
    const now = new Date('2026-11-15T08:00:00Z');
    expect(formatMoment(new Date('2026-11-15T17:00:00Z'), now, TZ)).toBe(
      'heute, 18:00 Uhr',
    );
    expect(formatMoment(new Date('2026-11-16T05:00:00Z'), now, TZ)).toBe(
      'morgen, 06:00 Uhr',
    );
    expect(formatMoment(new Date('2026-11-17T17:00:00Z'), now, TZ)).toBe(
      'Dienstag, 17. November 2026, 18:00 Uhr',
    );
  });

  it('formatDeadline: Mitternacht als 24 Uhr des Vortags', () => {
    expect(formatDeadline(new Date('2026-11-08T23:00:00Z'), TZ)).toBe(
      'Sonntag, 8. November 2026, 24:00 Uhr',
    );
    expect(formatDeadline(new Date('2026-11-09T17:00:00Z'), TZ)).toBe(
      'Montag, 9. November 2026, 18:00 Uhr',
    );
  });
});

describe('weekBeforeMail', () => {
  const checklist = buildChecklist({
    appUrl: APP,
    eventId: 'e1',
    eventActive: true,
    shopEnabled: true,
    qrCodes: 0,
    organization: {
      country: 'DE',
      operatingMode: 'cashless',
      operatingModeLegacy: false,
      legalComplete: false,
    },
    posDevices: 0,
    waiterModeDevices: 0,
    waiters: 0,
    printers: { total: 0, online: 0, printedRecently: 0 },
    products: { total: 3, withoutPrice: 0 },
    tse: {
      availability: 'available',
      active: false,
      integrationEnabled: false,
      missingMasterData: [],
    },
  });
  const mail = weekBeforeMail({
    ...base,
    now: new Date('2026-11-09T08:20:00Z'),
    checklist,
    realSalesFrom: new Date('2026-11-15T17:00:00Z'),
    presaleEnabled: false,
  });

  it('Betreff, Zaehler und Checkliste', () => {
    expect(mail.subject).toBe(
      'Dein Fest rückt näher: „Herbstfest & Kerwe“ am 16. November',
    );
    expect(mail.text).toContain('In 7 Tagen ist es so weit');
    expect(mail.text).toContain('2 Punkte sind noch offen.');
    expect(mail.text).toContain('[✗] Kasse verbinden');
    expect(mail.text).toContain(`Geräte: ${APP}/devices`);
    expect(mail.text).toContain('[✓] Produkte und Preise angelegt');
    expect(mail.html).toContain('&#10007;');
    expect(mail.html).toContain(`${APP}/settings?tab=org-legal`);
  });

  it('Testbetrieb bis zum Verkaufsstart', () => {
    expect(mail.text).toContain('Sonntag, 15. November 2026 um 18:00 Uhr');
    expect(mail.text).toContain('Testbestellungen');
  });

  it('Fremdtext wird entschärft, Abmeldelinks stehen drin', () => {
    expect(mail.html).toContain('TSV &lt;Musterstadt&gt;');
    expect(mail.html).not.toContain('TSV <Musterstadt>');
    expect(mail.html).toContain('Herbstfest &amp; Kerwe');
    expect(mail.text).toContain(`${APP}/settings?tab=preferences`);
    expect(mail.text).toContain(`${APP}/settings?tab=org-notifications`);
  });

  it('ohne Datumsphasen kein Testbetrieb-Hinweis', () => {
    const plain = weekBeforeMail({
      ...base,
      now: new Date('2026-11-10T08:20:00Z'),
      checklist,
      realSalesFrom: null,
      presaleEnabled: false,
    });
    expect(plain.text).not.toContain('Testbetrieb');
    expect(plain.text).toContain('In 6 Tagen');
  });
});

describe('dayBeforeMail', () => {
  const input = {
    ...base,
    now: new Date('2026-11-15T08:20:00Z'),
    realSalesFrom: new Date('2026-11-15T17:00:00Z'),
    realSalesUntil: new Date('2026-11-18T11:00:00Z'),
    datePhases: true,
    emergencyPhone: { phone: '+49 151 000000', telUri: 'tel:+49151000000' },
    tse: 'pending' as const,
  };

  it('Verkaufsstart, Loeschen der Testbestellungen, Notfallnummer, TSE', () => {
    const mail = dayBeforeMail(input);
    expect(mail.subject).toBe("Morgen geht's los: „Herbstfest & Kerwe“");
    expect(mail.text).toContain('Echter Verkauf ab: Heute, 18:00 Uhr');
    expect(mail.text).toContain('löschen wir alle Testbestellungen');
    expect(mail.text).toContain('+49 151 000000');
    expect(mail.html).toContain('href="tel:+49151000000"');
    expect(mail.text).toContain('Cloud-TSE: OpenEOS richtet deine Cloud-TSE');
    expect(mail.text).toContain(`${APP}/devices`);
  });

  it('ohne Notfallnummer und ohne TSE-Thema keine solchen Abschnitte', () => {
    const mail = dayBeforeMail({ ...input, emergencyPhone: null, tse: null });
    expect(mail.text).not.toContain('Notfall');
    expect(mail.text).not.toContain('Cloud-TSE');
  });
});

describe('afterEventMail', () => {
  const input = {
    ...base,
    now: new Date('2026-11-18T11:20:00Z'),
    lastDay: new Date('2026-11-17T05:00:00Z'),
    ordersOnly: false,
    currency: 'EUR',
    stats: {
      orders: 412,
      revenue: 5321.5,
      itemsSold: 1033,
      topProducts: [
        { name: 'Bratwurst', quantity: 220, revenue: 770 },
        { name: 'Bier 0,5 l', quantity: 180, revenue: 810 },
        { name: 'Pommes', quantity: 150, revenue: 450 },
      ],
    },
    waitersUsed: true,
    tseUsed: true,
    guestDataDays: 30,
  };

  // Intl setzt ein geschuetztes Leerzeichen vor das Eurozeichen.
  const plain = (text: string) => text.replace(/\u00a0/g, ' ');

  it('Zahlen, Top 3, Links und Loeschhinweis', () => {
    const raw = afterEventMail(input);
    const mail = { ...raw, text: plain(raw.text) };
    expect(mail.subject).toBe('Danke! So lief dein Fest „Herbstfest & Kerwe“');
    expect(mail.text).toContain('Bestellungen: 412');
    expect(mail.text).toContain('Umsatz: 5.321,50 €');
    expect(mail.text).toContain('1. Platz: Bratwurst · 220 Stück · 770,00 €');
    expect(mail.text).toContain(`Kellnerabrechnungen: ${APP}/waiters`);
    expect(mail.text).toContain(
      `Kassenabschlüsse und DSFinV-K: ${APP}/integrations/tse`,
    );
    expect(mail.text).toContain('30 Tage nach dem Ende');
    expect(mail.text).toContain('vom 16. November bis 17. November 2026');
  });

  it('„Nur Bons“: nur Mengen, keine Betraege', () => {
    const mail = afterEventMail({ ...input, ordersOnly: true });
    expect(mail.text).not.toContain('€');
    expect(mail.html).not.toContain('€');
    expect(mail.text).not.toContain('Umsatz:');
    expect(mail.text).toContain('1. Platz: Bratwurst · 220 Stück');
  });

  it('ohne Bedienungen, TSE und Loeschfrist fallen die Abschnitte weg', () => {
    const mail = afterEventMail({
      ...input,
      waitersUsed: false,
      tseUsed: false,
      guestDataDays: null,
    });
    expect(mail.text).not.toContain('Kellnerabrechnungen');
    expect(mail.text).not.toContain('DSFinV-K');
    expect(mail.text).not.toContain('löschen wir');
  });
});

describe('notBookedMail', () => {
  const input = {
    ...base,
    eventId: 'ev-1',
    testMaxOrders: 25,
    realSalesFrom: new Date('2026-11-15T17:00:00Z'),
    emergencySupport: true,
    tseIncluded: false,
  };

  it('Frist noch offen: bis wann kostenlos storniert werden kann', () => {
    const mail = notBookedMail({
      ...input,
      firstDay: new Date('2026-11-16T05:00:00Z'),
      now: new Date('2026-11-09T08:20:00Z'),
      cancellationDeadline: new Date('2026-11-09T17:00:00Z'),
    });
    expect(mail.subject).toBe(
      'Dein Fest am 16. November ist noch nicht freigeschaltet',
    );
    expect(mail.text).toContain(
      'Kostenlos stornieren kannst du bis 7 Tage vor Beginn, also bis Montag, 9. November 2026, 18:00 Uhr',
    );
    expect(mail.text).toContain(`${APP}/events?unlock=ev-1`);
    expect(mail.text).toContain('höchstens 25 Testbestellungen');
    expect(mail.text).toContain(
      'Echt verkauft wird ab Sonntag, 15. November 2026, 18:00 Uhr',
    );
    expect(mail.text).toContain('Notfall-Support');
  });

  it('genau 7 Tage vorher: Frist ist abgelaufen, Buchung verbindlich', () => {
    const mail = notBookedMail({
      ...input,
      now: new Date('2026-11-09T08:20:00Z'),
      cancellationDeadline: new Date('2026-11-08T23:00:00Z'),
    });
    expect(mail.text).toContain(
      'Für diesen Termin ist die Frist am Sonntag, 8. November 2026, 24:00 Uhr abgelaufen',
    );
    expect(mail.text).toContain('verbindlich');
    expect(mail.text).not.toContain('kannst du bis');
  });
});
