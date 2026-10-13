import {
  countBillableDays,
  countCalendarDays,
  listEventDayKeys,
  normalizeBusinessDayStartHour,
  parseEventDateInput,
} from './event-schedule.util';

const BERLIN = 'Europe/Berlin';

/* Zeitpunkte mit ausgeschriebenem Offset: Berlin ist bis zum 25.10.2026
   03:00 Sommerzeit (+02:00), danach Winterzeit (+01:00). Im Maerz springt
   die Uhr am 29.03.2026 um 02:00 auf 03:00. */
describe('countBillableDays (Geschaeftstage, 6 bis 6 Uhr)', () => {
  const days = (start: string, end?: string | null, timeZone = BERLIN) =>
    countBillableDays(start, end ?? null, timeZone);

  it.each([
    [
      'Sa 20:00 – So 02:00',
      '2026-10-17T20:00+02:00',
      '2026-10-18T02:00+02:00',
      1,
    ],
    [
      'Fr 17:00 – So 18:00',
      '2026-10-16T17:00+02:00',
      '2026-10-18T18:00+02:00',
      3,
    ],
    [
      'Sa 14:00 – Sa 23:00',
      '2026-10-17T14:00+02:00',
      '2026-10-17T23:00+02:00',
      1,
    ],
    [
      'Fr 18:00 – Sa 05:59',
      '2026-10-16T18:00+02:00',
      '2026-10-17T05:59+02:00',
      1,
    ],
    // Ende exklusiv: bis genau 6 Uhr ist vom Samstag nichts genutzt.
    [
      'Fr 18:00 – Sa 06:00',
      '2026-10-16T18:00+02:00',
      '2026-10-17T06:00+02:00',
      1,
    ],
    [
      'Fr 18:00 – Sa 06:01',
      '2026-10-16T18:00+02:00',
      '2026-10-17T06:01+02:00',
      2,
    ],
    // Beginn vor 6 Uhr gehoert zum Vortag.
    [
      'Sa 03:00 – Sa 05:00',
      '2026-10-17T03:00+02:00',
      '2026-10-17T05:00+02:00',
      1,
    ],
    [
      'Sa 03:00 – Sa 23:00',
      '2026-10-17T03:00+02:00',
      '2026-10-17T23:00+02:00',
      2,
    ],
    [
      'Sa 06:00 – Sa 23:00',
      '2026-10-17T06:00+02:00',
      '2026-10-17T23:00+02:00',
      1,
    ],
    [
      'Fr 20:00 – So 04:00',
      '2026-10-16T20:00+02:00',
      '2026-10-18T04:00+02:00',
      2,
    ],
  ])('%s → %i', (_label, start, end, expected) => {
    expect(days(start, end)).toBe(expected);
  });

  describe('Mitternacht', () => {
    it('Sa 22:00 – So 00:00 ist ein Tag', () => {
      expect(days('2026-10-17T22:00+02:00', '2026-10-18T00:00+02:00')).toBe(1);
    });

    it('Sa 23:00 – So 01:00 ist ein Tag', () => {
      expect(days('2026-10-17T23:00+02:00', '2026-10-18T01:00+02:00')).toBe(1);
    });

    /* So schickt das Formular reine Daten: beide Enden auf Mitternacht.
       Beide rutschen auf den Vortag, die Zahl bleibt die der Kalendertage. */
    it('Formular Fr bis So (Mitternacht) bleibt drei Tage', () => {
      expect(days('2026-10-16T00:00+02:00', '2026-10-18T00:00+02:00')).toBe(3);
    });

    it('Formular Sa bis Sa (Mitternacht) ist ein Tag', () => {
      expect(days('2026-10-17T00:00+02:00', '2026-10-17T00:00+02:00')).toBe(1);
    });
  });

  describe('Zeitumstellung', () => {
    // Letzter Sonntag im Oktober: 03:00 Sommerzeit wird 02:00 Winterzeit.
    it('Oktober: Sa 20:00 – So 02:00 ist ein Tag', () => {
      expect(days('2026-10-24T20:00+02:00', '2026-10-25T02:00+01:00')).toBe(1);
    });

    it('Oktober: Ende So 06:00 (Winterzeit) gehoert noch zum Samstag', () => {
      expect(days('2026-10-24T20:00+02:00', '2026-10-25T06:00+01:00')).toBe(1);
    });

    it('Oktober: Ende So 06:01 beginnt den Sonntag', () => {
      expect(days('2026-10-24T20:00+02:00', '2026-10-25T06:01+01:00')).toBe(2);
    });

    /* 05:30 Winterzeit waere 06:30 Sommerzeit. Wer mit einer festen
       Verschiebung rechnet statt mit der Wanduhrzeit, zaehlt hier zwei. */
    it('Oktober: So 05:30 Winterzeit zaehlt nach der Wanduhr', () => {
      expect(days('2026-10-24T20:00+02:00', '2026-10-25T05:30+01:00')).toBe(1);
    });

    it('Oktober: Fr 17:00 – So 18:00 bleibt drei Tage', () => {
      expect(days('2026-10-23T17:00+02:00', '2026-10-25T18:00+01:00')).toBe(3);
    });

    it('Oktober: Formular Fr bis So (Mitternacht) bleibt drei Tage', () => {
      expect(days('2026-10-23T00:00+02:00', '2026-10-25T00:00+02:00')).toBe(3);
    });

    // Letzter Sonntag im Maerz: 02:00 Winterzeit wird 03:00 Sommerzeit.
    it('Maerz: Sa 20:00 – So 04:00 ist ein Tag', () => {
      expect(days('2026-03-28T20:00+01:00', '2026-03-29T04:00+02:00')).toBe(1);
    });

    it('Maerz: Ende So 06:00 (Sommerzeit) gehoert noch zum Samstag', () => {
      expect(days('2026-03-28T20:00+01:00', '2026-03-29T06:00+02:00')).toBe(1);
    });

    it('Maerz: Ende So 06:01 beginnt den Sonntag', () => {
      expect(days('2026-03-28T20:00+01:00', '2026-03-29T06:01+02:00')).toBe(2);
    });

    it('Maerz: Fr 17:00 – So 18:00 bleibt drei Tage', () => {
      expect(days('2026-03-27T17:00+01:00', '2026-03-29T18:00+02:00')).toBe(3);
    });
  });

  describe('andere Zeitzone', () => {
    it('New York: Sa 20:00 – So 02:00 Ortszeit ist ein Tag', () => {
      expect(
        days(
          '2026-10-17T20:00-04:00',
          '2026-10-18T02:00-04:00',
          'America/New_York',
        ),
      ).toBe(1);
    });

    it('dieselben Zeitpunkte in Berlin sind zwei Tage (So 02:00 – So 08:00)', () => {
      expect(days('2026-10-17T20:00-04:00', '2026-10-18T02:00-04:00')).toBe(2);
    });

    it('Tokio: Fr 18:00 – Sa 05:00 ist ein Tag', () => {
      expect(
        days('2026-10-16T18:00+09:00', '2026-10-17T05:00+09:00', 'Asia/Tokyo'),
      ).toBe(1);
    });
  });

  describe('Randfaelle', () => {
    it('Ende vor Beginn ergibt einen Tag', () => {
      expect(days('2026-10-18T18:00+02:00', '2026-10-16T18:00+02:00')).toBe(1);
    });

    it('ohne Enddatum ist es ein Tag', () => {
      expect(days('2026-10-17T20:00+02:00')).toBe(1);
      expect(days('2026-10-17T03:00+02:00', undefined)).toBe(1);
    });

    it('ohne Beginn oder mit unlesbarem Datum ist es ein Tag', () => {
      expect(countBillableDays(null, null, BERLIN)).toBe(1);
      expect(countBillableDays('kein Datum', '2026-10-18', BERLIN)).toBe(1);
    });

    it('unlesbares Ende gilt als kein Ende', () => {
      expect(days('2026-10-16T17:00+02:00', 'kein Datum')).toBe(1);
    });

    it('nimmt Date-Objekte', () => {
      expect(
        countBillableDays(
          new Date('2026-10-16T17:00+02:00'),
          new Date('2026-10-18T18:00+02:00'),
          BERLIN,
        ),
      ).toBe(3);
    });
  });

  describe('konfigurierter Tageswechsel', () => {
    it('um 4 Uhr ist Fr 18:00 – Sa 05:00 zwei Tage', () => {
      expect(
        countBillableDays(
          '2026-10-16T18:00+02:00',
          '2026-10-17T05:00+02:00',
          BERLIN,
          4,
        ),
      ).toBe(2);
    });

    it('ungueltige Stunden fallen auf 6 Uhr zurueck', () => {
      for (const hour of [0, -1, 24, 6.5, Number.NaN]) {
        expect(
          countBillableDays(
            '2026-10-16T18:00+02:00',
            '2026-10-17T05:00+02:00',
            BERLIN,
            hour,
          ),
        ).toBe(1);
      }
    });
  });
});

describe('normalizeBusinessDayStartHour', () => {
  it.each([
    [6, 6],
    ['4', 4],
    [1, 1],
    [23, 23],
    [0, 6],
    [24, 6],
    [undefined, 6],
    ['abc', 6],
  ])('%p → %i', (input, expected) => {
    expect(normalizeBusinessDayStartHour(input)).toBe(expected);
  });
});

describe('countCalendarDays (Kalendertage)', () => {
  it('zaehlt jeden beruehrten Kalendertag, auch eine Nacht', () => {
    expect(
      countCalendarDays(
        '2026-10-17T20:00+02:00',
        '2026-10-18T02:00+02:00',
        BERLIN,
      ),
    ).toBe(2);
  });

  it('Fr bis So sind drei', () => {
    expect(
      countCalendarDays(
        '2026-10-16T00:00+02:00',
        '2026-10-18T00:00+02:00',
        BERLIN,
      ),
    ).toBe(3);
  });

  it('Ende vor Beginn und ohne Ende ergibt einen Tag', () => {
    expect(
      countCalendarDays(
        '2026-10-18T00:00+02:00',
        '2026-10-16T00:00+02:00',
        BERLIN,
      ),
    ).toBe(1);
    expect(countCalendarDays('2026-10-18T00:00+02:00', null, BERLIN)).toBe(1);
  });
});

describe('listEventDayKeys bleibt bei Kalendertagen', () => {
  it('liefert die Kalendertage der Shop-Liste, nicht die Geschaeftstage', () => {
    expect(
      listEventDayKeys(
        '2026-10-16T00:00+02:00',
        '2026-10-18T00:00+02:00',
        BERLIN,
      ),
    ).toEqual(['2026-10-16', '2026-10-17', '2026-10-18']);
    expect(
      listEventDayKeys(
        '2026-10-17T20:00+02:00',
        '2026-10-18T02:00+02:00',
        BERLIN,
      ),
    ).toEqual(['2026-10-17', '2026-10-18']);
  });
});

describe('parseEventDateInput', () => {
  it('liest ein reines Datum als Mitternacht in der Zeitzone', () => {
    expect(parseEventDateInput('2026-10-17', BERLIN).toISOString()).toBe(
      '2026-10-16T22:00:00.000Z',
    );
    expect(parseEventDateInput('2026-10-26', BERLIN).toISOString()).toBe(
      '2026-10-25T23:00:00.000Z',
    );
    expect(
      parseEventDateInput('2026-10-17', 'America/New_York').toISOString(),
    ).toBe('2026-10-17T04:00:00.000Z');
  });

  it('laesst vollstaendige Zeitpunkte unveraendert', () => {
    expect(
      parseEventDateInput('2026-10-17T20:00:00.000Z', BERLIN).toISOString(),
    ).toBe('2026-10-17T20:00:00.000Z');
  });

  it('ein Vorschau-Zeitraum aus reinen Daten zaehlt wie die Kalendertage', () => {
    const start = parseEventDateInput('2026-10-23', BERLIN);
    const end = parseEventDateInput('2026-10-25', BERLIN);
    expect(countBillableDays(start, end, BERLIN)).toBe(3);
  });
});
